import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRpc = vi.fn()

vi.mock('./client', () => ({
  getServiceClient: () => ({ rpc: (name: string, args: unknown) => mockRpc(name, args) }),
}))

import { reverseCreditsForPayment } from './credits'

const INPUT = {
  paymentId: 'pay-1',
  provider: 'stripe' as const,
  providerRefundId: 're_1',
  kind: 'refund' as const,
  rooms: 3,
  followUps: 0,
  amountMinor: 49900,
  currency: 'inr',
  reason: 'requested_by_customer',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('reverseCreditsForPayment', () => {
  it('passes the refund through to the database function untouched', () => {
    // Every decision that has to be atomic lives in reverse_user_credits. If a
    // field is dropped here the reversal still succeeds and silently reverses the
    // wrong amount, which is invisible until a customer complains.
    mockRpc.mockResolvedValue({ data: { applied: true, reason: 'reversed' } })

    return reverseCreditsForPayment(INPUT).then(() => {
      expect(mockRpc).toHaveBeenCalledWith('reverse_user_credits', {
        p_payment_id: 'pay-1',
        p_provider: 'stripe',
        p_provider_refund_id: 're_1',
        p_kind: 'refund',
        p_rooms: 3,
        p_follow_ups: 0,
        p_amount_minor: 49900,
        p_currency: 'inr',
        p_reason: 'requested_by_customer',
        p_dispute_status: null,
      })
    })
  })

  it('reports a shortfall rather than losing it in the mapping', async () => {
    // The shortfall is the whole reason the refund row exists: credits already
    // spent, money already returned. A snake_case field read under the wrong name
    // comes back undefined and reads as a clean reversal.
    mockRpc.mockResolvedValue({
      data: {
        applied: true,
        reason: 'reversed',
        rooms_reversed: 1,
        follow_ups_reversed: 0,
        rooms_shortfall: 2,
        follow_ups_shortfall: 4,
        needs_review: true,
      },
    })

    expect(await reverseCreditsForPayment(INPUT)).toEqual({
      applied: true,
      reason: 'reversed',
      roomsReversed: 1,
      followUpsReversed: 0,
      roomsShortfall: 2,
      followUpsShortfall: 4,
      needsReview: true,
    })
  })

  it('reads a redelivery as not applied', async () => {
    mockRpc.mockResolvedValue({ data: { applied: false, reason: 'already_recorded', rooms_reversed: 3 } })

    const result = await reverseCreditsForPayment(INPUT)
    expect(result.applied).toBe(false)
    expect(result.reason).toBe('already_recorded')
    expect(result.roomsReversed).toBe(3)
  })

  it('throws when the RPC fails, so the caller can ask for redelivery', async () => {
    // Swallowing this would leave the money returned and the credits in place,
    // with nothing left to retry from: the webhook is the only notification.
    mockRpc.mockResolvedValue({ data: null, error: { message: 'could not serialize access' } })

    await expect(reverseCreditsForPayment(INPUT)).rejects.toMatchObject({
      message: 'could not serialize access',
    })
  })
})
