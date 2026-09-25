import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockVerify = vi.fn()
const mockRefunded = vi.fn()
const mockDispute = vi.fn()

vi.mock('@/lib/billing/providers/stripe', () => ({
  verifyStripeWebhookSignature: (body: string, sig: string | null) => mockVerify(body, sig),
  retrieveCheckoutSession: async () => ({ id: 'cs_1', payment_status: 'unpaid' }),
}))

vi.mock('@/lib/billing/refunds', () => ({
  handleChargeRefunded: (payload: unknown) => mockRefunded(payload),
  handleChargeDisputeCreated: (payload: unknown) => mockDispute(payload),
}))

vi.mock('@/lib/db/client', () => ({
  getServiceClient: () => {
    throw new Error('the refund path must not reach the database directly')
  },
}))

import { POST } from './route'

function request(body: unknown) {
  const raw = JSON.stringify(body)
  return {
    text: async () => raw,
    headers: new Headers({ 'stripe-signature': 't=1,v1=deadbeef' }),
  } as unknown as import('next/server').NextRequest
}

function event(type: string) {
  return { id: 'evt_1', type, data: { object: { id: 'ch_1' } } }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockVerify.mockImplementation(async (body: string) => {
    const parsed = JSON.parse(body) as { id: string; type: string }
    return { valid: true, eventId: parsed.id, eventType: parsed.type, payload: parsed }
  })
})

describe('POST /api/webhooks/stripe — refunds and disputes', () => {
  it('reverses credits on charge.refunded and answers 2xx', async () => {
    mockRefunded.mockResolvedValue({ retry: false, result: 'reversed' })

    const res = await POST(request(event('charge.refunded')))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true, result: 'reversed' })
    expect(mockRefunded).toHaveBeenCalledTimes(1)
  })

  it('answers 2xx for a refund it could not act on', async () => {
    // A charge with no payment_id of ours will fail identically on every retry,
    // and a non-2xx makes Stripe redeliver it for three days.
    mockRefunded.mockResolvedValue({ retry: false, result: 'no_payment_id' })

    const res = await POST(request(event('charge.refunded')))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true, result: 'no_payment_id' })
  })

  it('answers 500 when the reversal itself failed', async () => {
    // The mirror of the crediting failure above it: the money is back with the
    // customer and the credits are still on the account, so a redelivery is
    // exactly what is wanted.
    mockRefunded.mockResolvedValue({ retry: true, result: 'reversal_failed', message: 'deadlock' })

    const res = await POST(request(event('charge.refunded')))
    expect(res.status).toBe(500)
  })

  it('records a dispute through its own handler', async () => {
    mockDispute.mockResolvedValue({ retry: false, result: 'dispute_recorded' })

    const res = await POST(request(event('charge.dispute.created')))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true, result: 'dispute_recorded' })
    expect(mockRefunded).not.toHaveBeenCalled()
  })

  it('still ignores every other event with a 2xx', async () => {
    const res = await POST(request(event('payment_intent.created')))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true, result: 'ignored' })
    expect(mockRefunded).not.toHaveBeenCalled()
    expect(mockDispute).not.toHaveBeenCalled()
  })

  it('rejects a bad signature before any refund work happens', async () => {
    // The only non-2xx that is not asking for a retry, and the only thing that
    // must be decided before the payload is treated as Stripe's.
    mockVerify.mockResolvedValue({ valid: false, reason: 'mismatch' })

    const res = await POST(request(event('charge.refunded')))

    expect(res.status).toBe(400)
    expect(mockRefunded).not.toHaveBeenCalled()
  })
})
