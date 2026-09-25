import { describe, it, expect } from 'vitest'
import {
  classifyPayment,
  reconcileWindow,
  reconcilePayments,
  summariseReport,
  MAX_PAYMENTS_PER_STATUS,
  RECONCILE_WINDOW_DAYS,
  SETTLEMENT_GRACE_MINUTES,
  type LoadPaymentsArgs,
  type ReconcilablePayment,
  type ReconcileDeps,
  type SessionLookup,
} from './reconcile'

const NOW = Date.parse('2026-09-25T12:00:00.000Z')

function payment(over: Partial<ReconcilablePayment> = {}): ReconcilablePayment {
  return {
    id: 'pay_1',
    user_id: 'user_1',
    product_key: '3_rooms',
    status: 'pending',
    provider_order_id: 'cs_test_1',
    amount_paise: 499,
    currency: 'SGD',
    created_at: '2026-09-25T10:00:00.000Z',
    ...over,
  }
}

const paid: SessionLookup = { state: 'found', session: { id: 'cs_test_1', payment_status: 'paid' } }
const unpaid: SessionLookup = { state: 'found', session: { id: 'cs_test_1', payment_status: 'unpaid' } }

describe('classifyPayment', () => {
  it('settles a pending payment whose Stripe session is paid', () => {
    // The incident this job exists for: paid in Stripe, pending here for an hour
    // because the Worker had no webhook secret, credits never granted.
    expect(classifyPayment(payment(), paid)).toMatchObject({ action: 'settle', code: 'paid_but_pending' })
  })

  it('does not settle a pending payment whose session is unpaid', () => {
    // An abandoned checkout is pending forever and is not a discrepancy.
    // Crediting these would hand out packs to anyone who opened checkout and left.
    expect(classifyPayment(payment(), unpaid)).toMatchObject({ action: 'leave', code: 'awaiting_payment' })
  })

  it('leaves an already-completed payment alone', () => {
    // A completed payment has already been credited under the RPC's row lock.
    // Anything other than `leave` here is a double-credit.
    expect(classifyPayment(payment({ status: 'completed' }), paid)).toMatchObject({
      action: 'leave',
      code: 'already_settled',
    })
  })

  it('flags a completed payment that Stripe says was never paid', () => {
    // The more serious direction: credits granted for money we did not take.
    // Reported, never "fixed" here — reversing a grant is a human decision.
    expect(classifyPayment(payment({ status: 'completed' }), unpaid)).toMatchObject({
      action: 'flag',
      code: 'settled_without_payment',
    })
  })

  it('separates "Stripe has no such session" from "Stripe says unpaid"', () => {
    // Collapsing these would report a lookup failure as money we never took,
    // and one false alarm in this report is enough for people to stop reading it.
    expect(classifyPayment(payment({ status: 'completed' }), { state: 'unknown_to_stripe' })).toMatchObject({
      action: 'flag',
      code: 'settled_without_session',
    })
    expect(classifyPayment(payment({ status: 'completed' }), { state: 'no_reference' })).toMatchObject({
      action: 'flag',
      code: 'settled_without_session',
    })
  })

  it('flags rather than settles a pending row with no session recorded', () => {
    // create-order writes provider_order_id in a second statement, so a row can
    // exist with no session id. There is nothing to verify against, so it must
    // not be treated as either healthy or payable.
    expect(classifyPayment(payment({ provider_order_id: null }), { state: 'no_reference' })).toMatchObject({
      action: 'flag',
      code: 'pending_without_session',
    })
  })

  it('refuses to credit a paid session whose product key is unknown', () => {
    // A renamed or retired pack would otherwise be credited as whatever
    // PRODUCTS[undefined] happens to be — i.e. a crash or zero credits recorded
    // as a successful settlement.
    expect(classifyPayment(payment({ product_key: '50_rooms_legacy' }), paid)).toMatchObject({
      action: 'flag',
      code: 'unknown_product',
    })
  })

  it('treats no_payment_required as not paid, exactly as the webhook does', () => {
    // The two settlement paths must agree on what "paid" means; if they drift,
    // the one that drifts is the unattended one granting credits at 3am.
    const lookup: SessionLookup = { state: 'found', session: { id: 'cs_test_1', payment_status: 'no_payment_required' } }
    expect(classifyPayment(payment(), lookup).action).toBe('leave')
  })
})

describe('reconcileWindow', () => {
  it('ends the window short of now by the grace period', () => {
    // Without the grace period every run would report the checkout someone is
    // still filling in, and a report that always shows problems gets ignored.
    const { since, until } = reconcileWindow(NOW)
    expect(Date.parse(until)).toBe(NOW - SETTLEMENT_GRACE_MINUTES * 60_000)
    expect(Date.parse(since)).toBe(NOW - RECONCILE_WINDOW_DAYS * 86_400_000)
  })
})

interface FakeOptions {
  pending?: ReconcilablePayment[]
  completed?: ReconcilablePayment[]
  sessions?: Record<string, SessionLookup>
  settleResult?: 'credited' | 'already_credited'
  sessionError?: (sessionId: string) => Error | null
}

function fakeDeps(opts: FakeOptions): { deps: ReconcileDeps; settled: string[]; asked: string[] } {
  const settled: string[] = []
  const asked: string[] = []

  const deps: ReconcileDeps = {
    now: () => NOW,
    async loadPayments({ status, limit }: LoadPaymentsArgs) {
      return (status === 'pending' ? (opts.pending ?? []) : (opts.completed ?? [])).slice(0, limit)
    },
    async loadSession(sessionId: string) {
      asked.push(sessionId)
      const failure = opts.sessionError?.(sessionId)
      if (failure) throw failure
      return opts.sessions?.[sessionId] ?? unpaid
    },
    async settle(p: ReconcilablePayment) {
      settled.push(p.id)
      return opts.settleResult ?? 'credited'
    },
  }

  return { deps, settled, asked }
}

describe('reconcilePayments', () => {
  it('settles only the payment Stripe has actually been paid for', async () => {
    const { deps, settled } = fakeDeps({
      pending: [
        payment({ id: 'pay_paid', provider_order_id: 'cs_paid' }),
        payment({ id: 'pay_abandoned', provider_order_id: 'cs_open' }),
      ],
      sessions: {
        cs_paid: { state: 'found', session: { id: 'cs_paid', payment_status: 'paid' } },
        cs_open: { state: 'found', session: { id: 'cs_open', payment_status: 'unpaid' } },
      },
    })

    const report = await reconcilePayments(deps)

    expect(settled).toEqual(['pay_paid'])
    expect(report.settled.map((f) => f.paymentId)).toEqual(['pay_paid'])
    expect(report.needsHuman).toEqual([])
  })

  it('never calls the credit path for a payment already completed', async () => {
    // Guards the double-credit case directly: reconciliation running while the
    // webhook has already settled the same payment.
    const { deps, settled } = fakeDeps({
      completed: [payment({ id: 'pay_done', status: 'completed', provider_order_id: 'cs_paid' })],
      sessions: { cs_paid: { state: 'found', session: { id: 'cs_paid', payment_status: 'paid' } } },
    })

    const report = await reconcilePayments(deps)

    expect(settled).toEqual([])
    expect(report.settled).toEqual([])
    expect(report.needsHuman).toEqual([])
    expect(report.headline).toContain('All clear')
  })

  it('records that a webhook won the race instead of claiming a fix', async () => {
    // add_user_credits returns FALSE when the payment was settled between our
    // read and our write. Reporting that as "credits granted" would make the
    // report claim work it did not do.
    const { deps } = fakeDeps({
      pending: [payment({ id: 'pay_raced', provider_order_id: 'cs_paid' })],
      sessions: { cs_paid: { state: 'found', session: { id: 'cs_paid', payment_status: 'paid' } } },
      settleResult: 'already_credited',
    })

    const report = await reconcilePayments(deps)
    expect(report.settled[0]?.outcome).toBe('already_credited')
  })

  it('keeps going after a row that cannot be checked', async () => {
    // One unreadable session used to be enough to abort a pass — and the row
    // left unexamined is exactly the one somebody is waiting on.
    const { deps, settled } = fakeDeps({
      pending: [
        payment({ id: 'pay_broken', provider_order_id: 'cs_broken' }),
        payment({ id: 'pay_paid', provider_order_id: 'cs_paid' }),
      ],
      sessions: { cs_paid: { state: 'found', session: { id: 'cs_paid', payment_status: 'paid' } } },
      sessionError: (id) => (id === 'cs_broken' ? new Error('Stripe GET failed (500)') : null),
    })

    const report = await reconcilePayments(deps)

    expect(settled).toEqual(['pay_paid'])
    expect(report.errors).toEqual([{ paymentId: 'pay_broken', message: 'Stripe GET failed (500)' }])
  })

  it('says so when more rows are waiting than one pass examines', async () => {
    // A silently truncated pass looks identical to a clean one, which is the
    // failure mode this whole job is meant to remove.
    const many = Array.from({ length: MAX_PAYMENTS_PER_STATUS }, (_, i) =>
      payment({ id: `pay_${i}`, provider_order_id: `cs_${i}` })
    )
    const { deps } = fakeDeps({ pending: many })

    const report = await reconcilePayments(deps)
    expect(report.truncated).toBe(true)
    expect(report.lines.some((l) => l.includes('More rows are waiting'))).toBe(true)
  })
})

describe('summariseReport', () => {
  it('leads with whether anybody has to do something', () => {
    // The headline is what a human reads before deciding to read the rest, so it
    // has to carry the answer on its own.
    const base = {
      window: reconcileWindow(NOW),
      checked: { pending: 2, completed: 1 },
      settled: [],
      needsHuman: [],
      errors: [],
      truncated: false,
    }

    expect(summariseReport(base).headline).toContain('All clear')
    expect(
      summariseReport({
        ...base,
        needsHuman: [
          {
            paymentId: 'pay_x',
            userId: 'user_1',
            productKey: '3_rooms',
            amount: 'S$4.99',
            dbStatus: 'completed',
            sessionId: 'cs_x',
            ageMinutes: 90,
            code: 'settled_without_payment' as const,
            note: 'Stripe says unpaid.',
          },
        ],
      }).headline
    ).toContain('1 needing a human')
  })
})
