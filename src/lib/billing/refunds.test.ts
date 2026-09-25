import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const mockReverse = vi.fn()

vi.mock('@/lib/env', () => ({
  getEnv: () => ({ STRIPE_SECRET_KEY: 'sk_test' }),
}))

let paymentRow: unknown = { id: 'pay-1', product_key: '3_rooms', amount_paise: 49900 }

vi.mock('@/lib/db/client', () => ({
  getServiceClient: () => ({
    from: () => {
      const builder: Record<string, unknown> = {}
      for (const method of ['select', 'eq']) builder[method] = vi.fn(() => builder)
      builder['maybeSingle'] = vi.fn(async () => ({ data: paymentRow }))
      return builder
    },
  }),
}))

vi.mock('@/lib/db/credits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/credits')>()
  return {
    ...actual,
    reverseCreditsForPayment: (input: unknown) => mockReverse(input),
  }
})

import { handleChargeRefunded, handleChargeDisputeCreated, planRefundReversal } from './refunds'

/** What Stripe returns for each GET this module makes; overridden per test. */
let stripeObjects: Record<string, unknown>

function fakeStripe() {
  return vi.fn(async (url: string | URL) => {
    const key = String(url).replace('https://api.stripe.com/v1', '')
    const body = stripeObjects[key]
    if (!body) {
      return { ok: false, status: 404, text: async () => 'No such object', json: async () => ({}) }
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  })
}

const CHARGE = {
  id: 'ch_1',
  amount: 49900,
  amount_refunded: 49900,
  currency: 'inr',
  refunded: true,
  payment_intent: 'pi_1',
  metadata: { payment_id: 'pay-1' },
  refunds: { data: [{ id: 're_1' }] },
}

const SUCCEEDED_REFUND = { id: 're_1', charge: 'ch_1', amount: 49900, currency: 'inr', status: 'succeeded' }

const CLEAN_REVERSAL = {
  applied: true,
  reason: 'reversed',
  roomsReversed: 3,
  followUpsReversed: 0,
  roomsShortfall: 0,
  followUpsShortfall: 0,
  needsReview: false,
}

function refundEvent(charge: Record<string, unknown> = CHARGE) {
  return { type: 'charge.refunded', data: { object: charge } }
}

beforeEach(() => {
  vi.clearAllMocks()
  paymentRow = { id: 'pay-1', product_key: '3_rooms', amount_paise: 49900 }
  stripeObjects = { '/charges/ch_1': CHARGE, '/refunds/re_1': SUCCEEDED_REFUND }
  mockReverse.mockResolvedValue(CLEAN_REVERSAL)
  vi.stubGlobal('fetch', fakeStripe())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('planRefundReversal', () => {
  it('reverses the whole grant when the charge is fully refunded', () => {
    expect(planRefundReversal('3_rooms', { amountMinor: 49900, amountRefundedMinor: 49900 }))
      .toEqual({ rooms: 3, followUps: 0 })
    expect(planRefundReversal('10_followups', { amountMinor: 19900, amountRefundedMinor: 19900 }))
      .toEqual({ rooms: 0, followUps: 10 })
  })

  it('never reverses more than the product ever granted', () => {
    // A refund larger than the charge (a duplicate-charge correction issued
    // against the wrong amount) must not invent credits to take back, which
    // would silently empty a balance filled by a different purchase.
    expect(planRefundReversal('3_rooms', { amountMinor: 49900, amountRefundedMinor: 999999 }))
      .toEqual({ rooms: 3, followUps: 0 })
  })

  it('scales a partial refund to the nearest whole unit', () => {
    // A pack price does not divide evenly: one room of the ₹499 three-pack is
    // ₹166.33, so the agent refunds 16633 and the true figure is 0.99998 rooms.
    // Flooring that reverses nothing, and the refund quietly fails to do the one
    // thing it was for.
    expect(planRefundReversal('3_rooms', { amountMinor: 49900, amountRefundedMinor: 16633 }))
      .toEqual({ rooms: 1, followUps: 0 })
    expect(planRefundReversal('10_followups', { amountMinor: 19900, amountRefundedMinor: 5970 }))
      .toEqual({ rooms: 0, followUps: 3 })
  })

  it('leaves a token partial refund alone', () => {
    // A small goodwill gesture is not a reversal. Taking a room from someone who
    // still paid nearly all of its price, possibly mid-mediation, is worse than
    // letting the discount stand.
    expect(planRefundReversal('1_room', { amountMinor: 19900, amountRefundedMinor: 2000 }))
      .toEqual({ rooms: 0, followUps: 0 })
  })

  it('treats a zero or missing charge amount as a full refund', () => {
    // Dividing by it would make the fraction NaN and floor(NaN) is NaN, which
    // reaches the database as a null and reverses nothing at all.
    expect(planRefundReversal('3_rooms', { amountMinor: 0, amountRefundedMinor: 0 }))
      .toEqual({ rooms: 3, followUps: 0 })
  })

  it('reverses nothing for a product key it does not recognise', () => {
    // Retired product keys stay on old payments rows forever. Guessing a grant
    // for one would take credits nobody can account for.
    expect(planRefundReversal('legacy_pack', { amountMinor: 49900, amountRefundedMinor: 49900 }))
      .toEqual({ rooms: 0, followUps: 0 })
  })
})

describe('handleChargeRefunded', () => {
  it('reverses against the refund id, not the charge', async () => {
    // The refund id is what makes a redelivery idempotent in the database. Keying
    // on the charge instead would collapse two genuine partial refunds into one.
    const result = await handleChargeRefunded(refundEvent())

    expect(result).toMatchObject({ retry: false, result: 'reversed' })
    expect(mockReverse).toHaveBeenCalledTimes(1)
    expect(mockReverse.mock.calls[0]?.[0]).toMatchObject({
      paymentId: 'pay-1',
      provider: 'stripe',
      providerRefundId: 're_1',
      kind: 'refund',
      rooms: 3,
      followUps: 0,
      amountMinor: 49900,
    })
  })

  it('re-reads the refund from Stripe instead of trusting the signed body', async () => {
    // A signature proves the body came from Stripe, not that the refund still
    // stands. This body claims a succeeded full refund; Stripe says it failed.
    stripeObjects['/refunds/re_1'] = { ...SUCCEEDED_REFUND, status: 'failed' }

    const result = await handleChargeRefunded(
      refundEvent({ ...CHARGE, refunds: { data: [{ id: 're_1' }] } })
    )

    expect(result).toEqual({ retry: false, result: 'refund_failed' })
    expect(mockReverse).not.toHaveBeenCalled()
  })

  it('leaves a pending refund alone until it succeeds', async () => {
    // A pending refund can still fail, and reversing on it takes credits from a
    // customer who never got their money.
    stripeObjects['/refunds/re_1'] = { ...SUCCEEDED_REFUND, status: 'pending' }

    expect(await handleChargeRefunded(refundEvent())).toEqual({ retry: false, result: 'refund_pending' })
    expect(mockReverse).not.toHaveBeenCalled()
  })

  it('reports a redelivery as already recorded without reversing twice', async () => {
    // Stripe redelivers until it gets a 2xx and replays old events on demand.
    // A second reversal would empty a balance the customer has refilled since.
    mockReverse.mockResolvedValue({
      ...CLEAN_REVERSAL,
      applied: false,
      reason: 'already_recorded',
      roomsReversed: 3,
    })

    expect(await handleChargeRefunded(refundEvent())).toMatchObject({
      retry: false,
      result: 'already_recorded',
    })
  })

  it('accepts a shortfall when the credits were already spent', async () => {
    // The case that cannot be undone: the mediation happened and cost real money.
    // The reversal takes what is left, stops at zero, and the row is flagged —
    // it must not read as a failure, or Stripe would redeliver it forever.
    mockReverse.mockResolvedValue({
      applied: true,
      reason: 'reversed',
      roomsReversed: 1,
      followUpsReversed: 0,
      roomsShortfall: 2,
      followUpsShortfall: 0,
      needsReview: true,
    })

    const result = await handleChargeRefunded(refundEvent())

    expect(result.retry).toBe(false)
    expect(result).toMatchObject({ result: 'reversed' })
  })

  it('asks Stripe to redeliver when the reversal itself fails', async () => {
    // The one retryable case: the money is back with the customer and the
    // credits are still on the account.
    mockReverse.mockRejectedValue(new Error('deadlock detected'))

    expect(await handleChargeRefunded(refundEvent())).toEqual({
      retry: true,
      result: 'reversal_failed',
      message: 'deadlock detected',
    })
  })

  it('falls back to the PaymentIntent when the charge carries no payment_id', async () => {
    // Charges only inherit PaymentIntent metadata for sessions created after
    // that was wired up; older ones have it only on the intent.
    stripeObjects['/charges/ch_1'] = { ...CHARGE, metadata: {} }
    stripeObjects['/payment_intents/pi_1'] = { metadata: { payment_id: 'pay-1' } }

    expect(await handleChargeRefunded(refundEvent())).toMatchObject({ result: 'reversed' })
  })

  it('gives up with a 2xx-shaped result when no payment can be identified', async () => {
    // Retrying an unidentifiable charge fails identically for three days. There
    // is nothing to reverse against: payments rows record the Checkout session,
    // not the charge.
    stripeObjects['/charges/ch_1'] = { ...CHARGE, metadata: {}, payment_intent: null }

    expect(await handleChargeRefunded(refundEvent())).toEqual({ retry: false, result: 'no_payment_id' })
    expect(mockReverse).not.toHaveBeenCalled()
  })

  it('gives up when the payments row is gone', async () => {
    paymentRow = null
    expect(await handleChargeRefunded(refundEvent())).toEqual({ retry: false, result: 'unknown_payment' })
    expect(mockReverse).not.toHaveBeenCalled()
  })
})

describe('handleChargeDisputeCreated', () => {
  const DISPUTE = {
    id: 'dp_1',
    charge: 'ch_1',
    amount: 49900,
    currency: 'inr',
    status: 'needs_response',
    reason: 'fraudulent',
  }

  beforeEach(() => {
    stripeObjects['/disputes/dp_1'] = DISPUTE
    mockReverse.mockResolvedValue({
      applied: true,
      reason: 'dispute_recorded',
      roomsReversed: 0,
      followUpsReversed: 0,
      roomsShortfall: 0,
      followUpsShortfall: 0,
      needsReview: true,
    })
  })

  it('records the dispute and moves no credits', async () => {
    // A dispute is a claim, not an outcome; the money is held and may come back.
    // Reversing here would punish a cardholder who is about to win, and there is
    // no re-grant path to undo it with.
    const result = await handleChargeDisputeCreated({ type: 'charge.dispute.created', data: { object: DISPUTE } })

    expect(result).toMatchObject({ retry: false, result: 'dispute_recorded' })
    expect(mockReverse.mock.calls[0]?.[0]).toMatchObject({
      paymentId: 'pay-1',
      kind: 'dispute',
      providerRefundId: 'dp_1',
      rooms: 0,
      followUps: 0,
      disputeStatus: 'needs_response',
      reason: 'fraudulent',
    })
  })

  it('asks for redelivery when the dispute could not be recorded', async () => {
    // An unrecorded dispute has a response deadline nobody knows about, and
    // missing it loses by default.
    mockReverse.mockRejectedValue(new Error('connection reset'))

    expect(await handleChargeDisputeCreated({ data: { object: DISPUTE } })).toMatchObject({
      retry: true,
      result: 'dispute_record_failed',
    })
  })
})

describe('021_refunds.sql', () => {
  const sql = readFileSync(
    path.join(process.cwd(), 'supabase/migrations/021_refunds.sql'),
    'utf8'
  )

  it('keeps the reversal clamped so a balance cannot go negative', () => {
    // The clamp is arithmetic (LEAST against the available balance) rather than
    // a conditional, and it lives in SQL because it has to happen under the row
    // lock. Without it the UPDATE trips CHECK (rooms_available >= 0), the RPC
    // errors, the route answers 500, and Stripe redelivers the same refund for
    // three days while the reversal never lands.
    expect(sql).toMatch(/v_rooms_taken\s*:=\s*LEAST\(v_rooms_wanted,\s*COALESCE\(v_rooms_have,\s*0\)\)/)
    expect(sql).toMatch(/v_follow_ups_taken\s*:=\s*LEAST\(v_follow_ups_wanted,\s*COALESCE\(v_follow_ups_have,\s*0\)\)/)
    expect(sql).toContain('FROM user_credits WHERE user_id = v_user_id FOR UPDATE')
  })

  it('keeps the idempotency key a unique index rather than a route-side check', () => {
    // Same reasoning as add_user_credits in 018: two deliveries of one event race
    // each other, so "already handled?" is a constraint, not a SELECT the route
    // performs and then acts on.
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_refunds_provider_ref\s+ON payment_refunds \(provider, provider_refund_id\)/)
    expect(sql).toContain('ON CONFLICT (provider, provider_refund_id) DO NOTHING')
  })

  it('leaves payments.status alone as the settlement flag', () => {
    // add_user_credits decides "already credited?" from status = 'completed'.
    // Adding 'refunded' to that column would make a refunded payment look
    // uncredited, and the next redelivery would grant the pack again.
    expect(sql).not.toMatch(/status\s+IN\s*\([^)]*refunded/i)
  })
})
