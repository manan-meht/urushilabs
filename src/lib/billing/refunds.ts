/**
 * Refunds and disputes: turning a Stripe event into a credit reversal.
 *
 * Credits only ever moved forward until now. A refunded customer kept their
 * pack, and the two Stripe events that say so — charge.refunded and
 * charge.dispute.created — arrived at a webhook that answered 200 and dropped
 * them. supabase/migrations/021_refunds.sql carries the product reasoning for
 * what a reversal is allowed to do; this file decides HOW MUCH to reverse and
 * which payment it belongs to.
 *
 * Stripe is called over plain fetch, and deliberately not through the `stripe`
 * npm SDK, for the reason recorded in providers/stripe.ts: the SDK registers
 * every API resource up front, barely tree-shakes, and urushi ships to
 * Cloudflare Workers through OpenNext under a 25 MiB bundle ceiling. The request
 * helper there is module-private, and these three GETs are not worth widening
 * that file's surface for.
 *
 * Identifiers come from the webhook payload; every piece of STATE is re-read
 * from Stripe, matching the checkout path. A signature proves the body came from
 * Stripe, not that the refund it describes still stands — a refund can fail
 * after the event is generated, and acting on `amount` from the body would
 * reverse credits for money that never went back.
 */

import { getEnv } from '@/lib/env'
import { getServiceClient } from '@/lib/db/client'
import {
  PRODUCTS,
  reverseCreditsForPayment,
  type CreditReversal,
  type ProductKey,
} from '@/lib/db/credits'

const STRIPE_API = 'https://api.stripe.com/v1'

async function stripeGet<T>(path: string): Promise<T> {
  const { STRIPE_SECRET_KEY } = getEnv()
  if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured.')

  const res = await fetch(`${STRIPE_API}${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  })
  if (!res.ok) {
    throw new Error(`Stripe GET ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }
  return res.json() as Promise<T>
}

interface StripeRefund {
  id: string
  charge?: string
  amount?: number
  currency?: string
  /** 'succeeded' | 'pending' | 'failed' | 'canceled' | 'requires_action' */
  status?: string
  reason?: string | null
}

interface StripeCharge {
  id: string
  amount?: number
  amount_refunded?: number
  currency?: string
  refunded?: boolean
  payment_intent?: string | null
  metadata?: Record<string, string>
  refunds?: { data?: Array<{ id?: string }> }
}

interface StripeDispute {
  id: string
  charge?: string
  amount?: number
  currency?: string
  status?: string
  reason?: string | null
}

/**
 * What the route should do about it.
 *
 * `retry: true` is reserved for the one case worth asking Stripe to redeliver —
 * the money is back with the customer and the credits are still on the account.
 * Everything else is a 200, because a non-2xx makes Stripe retry an event that
 * will fail in exactly the same way for the next three days.
 */
export type RefundHandling =
  | { retry: false; result: string; reversal?: CreditReversal }
  | { retry: true; result: string; message: string }

export interface ReversalPlan {
  rooms: number
  followUps: number
}

/**
 * How many credits a refunded charge should take back.
 *
 * Scaled by the share of the charge refunded SO FAR rather than by the single
 * refund that triggered this event, because one refund's share rarely lands on a
 * whole credit and rounding each separately either loses a credit or invents one.
 * The total is safe to ask for repeatedly: reverse_user_credits subtracts what
 * earlier refunds on the same payment already took.
 *
 * Whole units, rounded to the NEAREST rather than down. A pack price rarely
 * divides evenly — one room of the ₹499 three-pack is ₹166.33 — so a support
 * agent refunding "one of the three" enters 16633, which is 0.99998 of a room
 * and floors to nothing. Rounding down looks conservative and in practice just
 * means the intended reversal silently does not happen.
 *
 * A charge refunded in full reverses the full grant.
 */
export function planRefundReversal(
  productKey: string,
  charge: { amountMinor: number; amountRefundedMinor: number }
): ReversalPlan {
  const product = PRODUCTS[productKey as ProductKey]
  if (!product) return { rooms: 0, followUps: 0 }

  // A zero or missing charge amount would make the fraction meaningless; the
  // only refund possible against it is a full one.
  const full = charge.amountMinor <= 0 || charge.amountRefundedMinor >= charge.amountMinor
  const fraction = full ? 1 : Math.max(charge.amountRefundedMinor, 0) / charge.amountMinor

  return {
    rooms: Math.min(Math.round(product.rooms * fraction), product.rooms),
    followUps: Math.min(Math.round(product.followUps * fraction), product.followUps),
  }
}

/**
 * Finds our payments row for a Stripe charge.
 *
 * The charge inherits the PaymentIntent's metadata, where checkout put
 * payment_id — but only for sessions created after that was added, so the
 * PaymentIntent is read as a fallback rather than assuming it is there. Without
 * a payment_id there is nothing to reverse against: the payments row records the
 * Checkout session id, not the charge, so no lookup on our side can find it.
 */
async function paymentIdForCharge(charge: StripeCharge): Promise<string | null> {
  const fromCharge = charge.metadata?.['payment_id']
  if (fromCharge) return fromCharge

  if (!charge.payment_intent) return null
  const intent = await stripeGet<{ metadata?: Record<string, string> }>(
    `/payment_intents/${encodeURIComponent(charge.payment_intent)}`
  )
  return intent.metadata?.['payment_id'] ?? null
}

async function loadPayment(paymentId: string) {
  const db = getServiceClient()
  const { data } = await db
    .from('payments')
    .select('id, product_key, amount_paise')
    .eq('id', paymentId)
    .maybeSingle()
  return data as { id: string; product_key: string; amount_paise: number } | null
}

/** charge.refunded — the money has gone back, in part or in full. */
export async function handleChargeRefunded(payload: unknown): Promise<RefundHandling> {
  const object = (payload as { data?: { object?: StripeCharge } }).data?.object
  const chargeId = object?.id
  if (!chargeId) return { retry: false, result: 'no_charge_id' }

  // The refund id is the idempotency key, so it has to name the refund this
  // event is about. Taken from the payload because it is an identifier, then
  // re-read for its state.
  const refundIdFromPayload = object?.refunds?.data?.[0]?.id

  const charge = await stripeGet<StripeCharge>(`/charges/${encodeURIComponent(chargeId)}`)
  const refundId = refundIdFromPayload ?? charge.refunds?.data?.[0]?.id
  if (!refundId) {
    console.error(`[stripe refunds] Charge ${chargeId} reports no refund to reverse.`)
    return { retry: false, result: 'no_refund_id' }
  }

  const refund = await stripeGet<StripeRefund>(`/refunds/${encodeURIComponent(refundId)}`)
  if (refund.status !== 'succeeded') {
    // A pending refund can still fail, and a failed one means the customer never
    // got the money. Either way there is nothing to take back yet; the refund
    // succeeding sends its own event.
    return { retry: false, result: `refund_${refund.status ?? 'unknown'}` }
  }

  const paymentId = await paymentIdForCharge(charge)
  if (!paymentId) {
    console.error(`[stripe refunds] Charge ${chargeId} has no payment_id metadata — cannot reverse.`)
    return { retry: false, result: 'no_payment_id' }
  }

  const payment = await loadPayment(paymentId)
  if (!payment) {
    console.error(`[stripe refunds] payment ${paymentId} not found for charge ${chargeId}.`)
    return { retry: false, result: 'unknown_payment' }
  }

  const plan = planRefundReversal(payment.product_key, {
    amountMinor: charge.amount ?? payment.amount_paise ?? 0,
    amountRefundedMinor: charge.amount_refunded ?? refund.amount ?? 0,
  })

  try {
    const reversal = await reverseCreditsForPayment({
      paymentId,
      provider: 'stripe',
      providerRefundId: refund.id,
      kind: 'refund',
      rooms: plan.rooms,
      followUps: plan.followUps,
      amountMinor: refund.amount ?? 0,
      currency: refund.currency ?? charge.currency ?? null,
      reason: refund.reason ?? null,
    })

    if (reversal.needsReview) {
      // Worth a log line rather than only a flagged row: this is money out with
      // the mediation already delivered, and nobody is watching the table.
      console.warn(
        `[stripe refunds] payment ${paymentId} refunded with a shortfall — ` +
          `rooms kept ${reversal.roomsShortfall}, follow-ups kept ${reversal.followUpsShortfall} ` +
          `(${reversal.reason}).`
      )
    }

    return { retry: false, result: reversal.reason, reversal }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { retry: true, result: 'reversal_failed', message }
  }
}

/**
 * charge.dispute.created — a chargeback has been opened.
 *
 * Recorded and flagged, and no credits move. The money is held rather than
 * returned and may come back to us; reversing now would punish a customer whose
 * card was used by someone else and whose dispute is about to be resolved in
 * their favour, and there is no re-grant path to undo that with.
 *
 * The outcome arrives as charge.dispute.closed, which is NOT handled yet, so a
 * lost dispute leaves credits on the account until someone acts on the flagged
 * row. That is the known gap in this handler.
 */
export async function handleChargeDisputeCreated(payload: unknown): Promise<RefundHandling> {
  const object = (payload as { data?: { object?: StripeDispute } }).data?.object
  const disputeId = object?.id
  if (!disputeId) return { retry: false, result: 'no_dispute_id' }

  const dispute = await stripeGet<StripeDispute>(`/disputes/${encodeURIComponent(disputeId)}`)
  if (!dispute.charge) {
    console.error(`[stripe refunds] Dispute ${disputeId} names no charge.`)
    return { retry: false, result: 'no_charge_id' }
  }

  const charge = await stripeGet<StripeCharge>(`/charges/${encodeURIComponent(dispute.charge)}`)
  const paymentId = await paymentIdForCharge(charge)
  if (!paymentId) {
    console.error(`[stripe refunds] Disputed charge ${charge.id} has no payment_id metadata.`)
    return { retry: false, result: 'no_payment_id' }
  }

  const payment = await loadPayment(paymentId)
  if (!payment) {
    console.error(`[stripe refunds] payment ${paymentId} not found for dispute ${disputeId}.`)
    return { retry: false, result: 'unknown_payment' }
  }

  try {
    const reversal = await reverseCreditsForPayment({
      paymentId,
      provider: 'stripe',
      providerRefundId: dispute.id,
      kind: 'dispute',
      rooms: 0,
      followUps: 0,
      amountMinor: dispute.amount ?? 0,
      currency: dispute.currency ?? charge.currency ?? null,
      reason: dispute.reason ?? null,
      disputeStatus: dispute.status ?? null,
    })

    // A dispute has a deadline for submitting evidence, and missing it loses by
    // default, so this is loud even though nothing went wrong.
    console.warn(
      `[stripe refunds] Dispute ${dispute.id} opened on payment ${paymentId} ` +
        `(${dispute.reason ?? 'no reason given'}, status ${dispute.status ?? 'unknown'}). ` +
        `Credits left in place pending the outcome.`
    )

    return { retry: false, result: reversal.reason, reversal }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { retry: true, result: 'dispute_record_failed', message }
  }
}
