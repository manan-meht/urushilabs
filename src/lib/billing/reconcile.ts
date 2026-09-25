/**
 * Stripe ↔ database reconciliation: the job that notices a webhook never arrived.
 *
 * A real test purchase was paid in Stripe and sat `pending` in our database for
 * an hour, granting nothing, because the production Worker had no
 * STRIPE_WEBHOOK_SECRET and /api/webhooks/stripe therefore refused every
 * delivery with a 503. It was caught only because a human happened to be
 * watching the screen — nothing in the system would have reported it.
 *
 * Webhooks also fail for entirely ordinary reasons: a bad deploy, a rotated
 * secret, a Stripe or Cloudflare outage, a retry budget exhausted. Every one of
 * them looks the same from the customer's side — they paid and received nothing
 * — and every one of them is currently silent.
 *
 * Stripe is the source of truth for whether money moved. This module re-reads it
 * and compares, then settles whatever should already have settled through
 * `add_user_credits`, the same RPC the webhook calls. That RPC decides "have we
 * credited this payment?" under the payment's row lock, which is what makes this
 * safe to run while a late webhook is landing for the same payment: whichever
 * arrives first credits, the other is told FALSE. Inventing a second settlement
 * path here instead would be the double-credit bug.
 */

import { getServiceClient } from '@/lib/db/client'
import { PRODUCTS, type ProductKey } from '@/lib/db/credits'
import { formatPrice } from './pricing'

/**
 * How far back a run looks. Stripe gives up retrying a failing endpoint after
 * about three days, so a window shorter than that can permanently miss the
 * exact case this job exists for. Seven days covers that plus a weekend of
 * nobody looking, without turning a job that runs every few minutes into a
 * full-history scan.
 */
export const RECONCILE_WINDOW_DAYS = 7

/**
 * Payments younger than this are ignored. A pending payment thirty seconds old
 * is someone still on the checkout page, not a fault — reporting those would
 * make every run show "discrepancies" and teach whoever reads it to stop
 * reading. Stripe normally delivers within seconds, so anything still pending
 * after ten minutes has genuinely missed the webhook path.
 */
export const SETTLEMENT_GRACE_MINUTES = 10

/**
 * Rows examined per status per run, newest first.
 *
 * Each one costs a Stripe read, and a settlement costs two more database calls.
 * Workers allow 50 subrequests per invocation on the free plan, so a pass has to
 * stay small.
 *
 * Newest first, not oldest: abandoned checkouts stay `pending` for the whole
 * window and pile up at the old end of it, so oldest-first ordering would spend
 * every run's entire budget re-reading the same dead sessions while a payment
 * someone is actually waiting on — always one of the newest rows — never got
 * looked at. Ordering this way, a row is only ever skipped when more than
 * MAX_PAYMENTS_PER_STATUS payments landed inside one window, and the skipped
 * rows are the ones earlier runs already examined.
 */
export const MAX_PAYMENTS_PER_STATUS = 20

/** The columns this job needs; a subset of `payments`. */
export interface ReconcilablePayment {
  id: string
  user_id: string
  product_key: string
  status: string
  provider_order_id: string | null
  amount_paise: number | null
  currency: string | null
  created_at: string
}

/** As much of a Checkout Session as reconciliation needs. */
export interface SessionSnapshot {
  id: string
  payment_status: string
}

/**
 * Three outcomes, kept apart on purpose. "Stripe says this session is unpaid"
 * and "we could not ask Stripe" are the same shape of ignorance but very
 * different claims, and collapsing them would let a lookup failure be reported
 * as money we took without crediting — a false alarm in the one report anybody
 * is going to trust.
 */
export type SessionLookup =
  | { state: 'found'; session: SessionSnapshot }
  | { state: 'no_reference' }
  | { state: 'unknown_to_stripe' }

export type VerdictCode =
  | 'already_settled'
  | 'awaiting_payment'
  | 'paid_but_pending'
  | 'settled_without_payment'
  | 'settled_without_session'
  | 'pending_without_session'
  | 'unknown_product'
  // Paid, but the account was deleted, so payments.user_id is NULL (migration 020).
  | 'no_owner'

export interface Verdict {
  /** `settle` grants credits; `flag` only reports; `leave` is the healthy case. */
  action: 'settle' | 'leave' | 'flag'
  code: VerdictCode
  /** One line a human can act on, written for whoever is scanning the output. */
  note: string
}

/**
 * The whole decision, as a pure function of our row and Stripe's answer.
 *
 * Only `payment_status === 'paid'` counts as paid, which is exactly what the
 * webhook checks. Treating `no_payment_required` as paid here would mean the two
 * paths disagree about what a settled purchase is, and the one that runs
 * unattended at 3am would be the one inventing credits.
 */
export function classifyPayment(payment: ReconcilablePayment, lookup: SessionLookup): Verdict {
  const paid = lookup.state === 'found' && lookup.session.payment_status === 'paid'

  // No owner to credit: the buyer deleted their account after paying.
  //
  // payments.user_id became nullable in migration 020, which anonymises
  // financial records rather than removing them — tax retention outlives a
  // deletion request, the identity does not. Settling would pass NULL to
  // add_user_credits and fail on user_credits' primary key, and this job would
  // report the same row as broken on every run forever.
  //
  // Flagged rather than left, because money was taken and nothing can be
  // granted for it: that is a refund only a human can decide to make.
  if (!payment.user_id) {
    return {
      action: 'flag',
      code: 'no_owner',
      note: 'Paid, but the account was deleted — no one to credit. Money taken with nothing granted; needs a manual refund.',
    }
  }

  if (payment.status === 'completed') {
    if (paid) return { action: 'leave', code: 'already_settled', note: 'Completed here, paid in Stripe.' }
    if (lookup.state === 'found') {
      return {
        action: 'flag',
        code: 'settled_without_payment',
        note: `Marked completed here, but Stripe says its session is "${lookup.session.payment_status}". Credits may have been granted for money we never took.`,
      }
    }
    return {
      action: 'flag',
      code: 'settled_without_session',
      note:
        lookup.state === 'no_reference'
          ? 'Marked completed here with no Stripe session recorded, so nothing can confirm the money moved.'
          : 'Marked completed here, but Stripe does not recognise the session id on the row.',
    }
  }

  if (lookup.state === 'no_reference') {
    return {
      action: 'flag',
      code: 'pending_without_session',
      note: 'Pending with no Stripe session recorded — checkout never opened, so there is nothing to reconcile against. Stuck row.',
    }
  }

  if (lookup.state === 'unknown_to_stripe') {
    return {
      action: 'flag',
      code: 'settled_without_session',
      note: 'Pending against a session id Stripe does not recognise.',
    }
  }

  if (!paid) {
    return { action: 'leave', code: 'awaiting_payment', note: `Stripe says "${lookup.session.payment_status}" — nothing was paid.` }
  }

  if (!(payment.product_key in PRODUCTS)) {
    // Crediting requires knowing what the pack contains. Guessing would be worse
    // than leaving it for a human.
    return {
      action: 'flag',
      code: 'unknown_product',
      note: `Paid in Stripe, but product_key "${payment.product_key}" is not in PRODUCTS, so there is nothing to grant.`,
    }
  }

  // Known gap, left in rather than papered over: a session stays `paid` after the
  // money is refunded, so a payment that was paid, never credited (broken
  // webhook), then refunded is settled here and the customer keeps credits for
  // money they got back. Closing it needs the charge's refunded amount, which
  // means a second Stripe surface this file deliberately does not open — see
  // billing/refunds.ts, whose owner is better placed to expose that check.
  return {
    action: 'settle',
    code: 'paid_but_pending',
    note: 'Paid in Stripe but still pending here — the webhook did not land. Settling now.',
  }
}

export interface PaymentFinding {
  paymentId: string
  /** Nullable since migration 020: a deleted account leaves its payments anonymised. */
  userId: string | null
  productKey: string
  amount: string
  dbStatus: string
  sessionId: string | null
  ageMinutes: number
  code: VerdictCode
  note: string
  outcome?: 'credited' | 'already_credited'
}

export interface ReconcileWindow {
  since: string
  /** Now minus the grace period, not now — see SETTLEMENT_GRACE_MINUTES. */
  until: string
}

export interface ReconcileReport {
  window: ReconcileWindow
  checked: { pending: number; completed: number }
  settled: PaymentFinding[]
  needsHuman: PaymentFinding[]
  errors: Array<{ paymentId: string; message: string }>
  /** True when a status hit its per-run cap, so more rows are waiting. */
  truncated: boolean
  headline: string
  lines: string[]
}

export interface LoadPaymentsArgs {
  status: 'pending' | 'completed'
  since: string
  until: string
  limit: number
}

export interface ReconcileDeps {
  loadPayments(args: LoadPaymentsArgs): Promise<ReconcilablePayment[]>
  loadSession(sessionId: string): Promise<SessionLookup>
  settle(payment: ReconcilablePayment, sessionId: string): Promise<'credited' | 'already_credited'>
  now(): number
}

export function reconcileWindow(nowMs: number): ReconcileWindow {
  return {
    since: new Date(nowMs - RECONCILE_WINDOW_DAYS * 86_400_000).toISOString(),
    until: new Date(nowMs - SETTLEMENT_GRACE_MINUTES * 60_000).toISOString(),
  }
}

function ageMinutes(createdAt: string, nowMs: number): number {
  const created = Date.parse(createdAt)
  return Number.isFinite(created) ? Math.round((nowMs - created) / 60_000) : -1
}

function describeAmount(payment: ReconcilablePayment): string {
  // amount_paise holds minor units of the row's own currency, despite the name
  // (see migration 018) — cents for Stripe markets.
  return formatPrice({ amountMinorUnits: payment.amount_paise ?? 0, currency: payment.currency ?? 'INR' })
}

/**
 * One pass. Every row is handled inside its own try/catch: a single payment whose
 * session Stripe refuses to return must not abort the pass, because the row that
 * would have gone unexamined is exactly the one someone is waiting on.
 */
export async function reconcilePayments(deps: ReconcileDeps): Promise<ReconcileReport> {
  const nowMs = deps.now()
  const range = reconcileWindow(nowMs)

  const settled: PaymentFinding[] = []
  const needsHuman: PaymentFinding[] = []
  const errors: Array<{ paymentId: string; message: string }> = []
  const checked = { pending: 0, completed: 0 }
  let truncated = false

  for (const status of ['pending', 'completed'] as const) {
    const rows = await deps.loadPayments({ ...range, status, limit: MAX_PAYMENTS_PER_STATUS })
    checked[status] = rows.length
    if (rows.length >= MAX_PAYMENTS_PER_STATUS) truncated = true

    for (const payment of rows) {
      try {
        const lookup: SessionLookup = payment.provider_order_id
          ? await deps.loadSession(payment.provider_order_id)
          : { state: 'no_reference' }

        const verdict = classifyPayment(payment, lookup)
        if (verdict.action === 'leave') continue

        const finding: PaymentFinding = {
          paymentId: payment.id,
          userId: payment.user_id,
          productKey: payment.product_key,
          amount: describeAmount(payment),
          dbStatus: payment.status,
          sessionId: payment.provider_order_id,
          ageMinutes: ageMinutes(payment.created_at, nowMs),
          code: verdict.code,
          note: verdict.note,
        }

        if (verdict.action === 'flag') {
          needsHuman.push(finding)
          continue
        }

        // Non-null because classifyPayment only returns `settle` for a found session.
        finding.outcome = await deps.settle(payment, payment.provider_order_id as string)
        settled.push(finding)
      } catch (err) {
        errors.push({ paymentId: payment.id, message: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  const { headline, lines } = summariseReport({ window: range, checked, settled, needsHuman, errors, truncated })
  return { window: range, checked, settled, needsHuman, errors, truncated, headline, lines }
}

/**
 * Turns a pass into something a human can read at a glance.
 *
 * There is no error monitoring on this deployment yet, so this text and the logs
 * are the entire reporting channel. It is written to be skimmed: the headline
 * alone has to say whether anybody needs to do something.
 */
export function summariseReport(
  report: Omit<ReconcileReport, 'headline' | 'lines'>
): { headline: string; lines: string[] } {
  const total = report.checked.pending + report.checked.completed
  const parts: string[] = []
  if (report.settled.length > 0) parts.push(`${report.settled.length} settled`)
  if (report.needsHuman.length > 0) parts.push(`${report.needsHuman.length} needing a human`)
  if (report.errors.length > 0) parts.push(`${report.errors.length} could not be checked`)

  const headline =
    parts.length === 0
      ? `All clear — ${total} Stripe payments checked, database agrees with Stripe.`
      : `${total} Stripe payments checked — ${parts.join(', ')}.`

  const lines: string[] = [
    headline,
    `Window: ${report.window.since} → ${report.window.until} (${report.checked.pending} pending, ${report.checked.completed} completed).`,
  ]

  if (report.truncated) {
    lines.push(
      `More rows are waiting than one run examines (cap ${MAX_PAYMENTS_PER_STATUS} per status). The newest were taken; older rows were examined by earlier runs.`
    )
  }

  if (report.settled.length > 0) {
    lines.push('', 'SETTLED — paid in Stripe, was still pending here:')
    for (const f of report.settled) {
      lines.push(
        `  • payment ${f.paymentId} — ${f.amount} ${f.productKey}, user ${f.userId}, pending ${f.ageMinutes} min, session ${f.sessionId} → ${f.outcome === 'already_credited' ? 'a webhook beat us to it, credited once' : 'credits granted'}`
      )
    }
  }

  if (report.needsHuman.length > 0) {
    lines.push('', 'NEEDS A HUMAN — this job will not fix these on its own:')
    for (const f of report.needsHuman) {
      lines.push(
        `  • payment ${f.paymentId} [${f.code}] — ${f.amount} ${f.productKey}, user ${f.userId}, ${f.dbStatus} for ${f.ageMinutes} min, session ${f.sessionId ?? 'none'}: ${f.note}`
      )
    }
  }

  if (report.errors.length > 0) {
    lines.push('', 'COULD NOT BE CHECKED — treat as unknown, not as healthy:')
    for (const e of report.errors) lines.push(`  • payment ${e.paymentId}: ${e.message}`)
  }

  return { headline, lines }
}

/**
 * The real implementations. Split out from `reconcilePayments` so the decision
 * logic can be tested without a database or a Stripe account, which is the only
 * way this job's behaviour gets exercised before it runs against real money.
 */
export function liveDeps(): ReconcileDeps {
  const db = getServiceClient()

  return {
    now: () => Date.now(),

    async loadPayments({ status, since, until, limit }) {
      const { data, error } = await db
        .from('payments')
        .select('id, user_id, product_key, status, provider_order_id, amount_paise, currency, created_at')
        .eq('provider', 'stripe')
        .eq('status', status)
        .gte('created_at', since)
        .lte('created_at', until)
        .order('created_at', { ascending: false })
        .limit(limit)

      if (error) throw new Error(`Loading ${status} payments failed: ${error.message}`)
      return (data ?? []) as ReconcilablePayment[]
    },

    async loadSession(sessionId) {
      // Dynamic, matching providerRegistry: the gateway module must not be pulled
      // into bundles that merely reach this file.
      const { retrieveCheckoutSession } = await import('./providers/stripe')
      try {
        const session = await retrieveCheckoutSession(sessionId)
        return { state: 'found', session: { id: session.id, payment_status: session.payment_status } }
      } catch (err) {
        // stripe.ts throws a plain Error with the status embedded in its message,
        // so that is the only signal available for "Stripe has never heard of
        // this session". Anything else rethrows and is reported as unchecked —
        // a transient 500 must not be recorded as money we never took.
        if (err instanceof Error && err.message.includes('(404)')) return { state: 'unknown_to_stripe' }
        throw err
      }
    },

    async settle(payment, sessionId) {
      const product = PRODUCTS[payment.product_key as ProductKey]
      if (!product) throw new Error(`No product definition for ${payment.product_key}`)

      // The same two writes the webhook makes, in the same order and with the
      // same values — provider_payment_id set to the session id included. That
      // pairing is what the unique index on (provider, provider_payment_id)
      // relies on to stop a second completed row for the same money; writing
      // something different here would quietly defeat it.
      await db
        .from('payments')
        .update({ provider: 'stripe', provider_order_id: sessionId, provider_payment_id: sessionId })
        .eq('id', payment.id)

      const { data: credited, error } = await db.rpc('add_user_credits', {
        p_user_id: payment.user_id,
        p_rooms: product.rooms,
        p_follow_ups: product.followUps,
        p_payment_id: payment.id,
      })

      if (error) throw new Error(`add_user_credits failed: ${error.message}`)
      return credited === false ? 'already_credited' : 'credited'
    },
  }
}
