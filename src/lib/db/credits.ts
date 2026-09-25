/**
 * User credit helpers — server-only.
 * Manages rooms_available and follow_ups_available per user.
 */

import { getServiceClient } from './client'

export interface UserCredits {
  rooms_available: number
  follow_ups_available: number
  total_rooms_created: number
}

/** Returns current credits, creating a fresh record (1 free room) if none exists. */
export async function getOrCreateCredits(userId: string): Promise<UserCredits> {
  const db = getServiceClient()

  const { data: existing } = await db
    .from('user_credits')
    .select('rooms_available, follow_ups_available, total_rooms_created')
    .eq('user_id', userId)
    .single()

  if (existing) return existing as UserCredits

  const { data: created } = await db
    .from('user_credits')
    .insert({ user_id: userId, rooms_available: 1, follow_ups_available: 0, total_rooms_created: 0 })
    .select('rooms_available, follow_ups_available, total_rooms_created')
    .single()

  return (created as UserCredits) ?? { rooms_available: 1, follow_ups_available: 0, total_rooms_created: 0 }
}

/**
 * Atomically consumes one room credit.
 * Returns true if successful, false if no credits available.
 */
export async function consumeRoomCredit(userId: string): Promise<boolean> {
  const db = getServiceClient()

  // Ensure record exists
  await getOrCreateCredits(userId)

  const { data, error } = await db.rpc('consume_room_credit', { p_user_id: userId })
  if (error) {
    console.error('[consumeRoomCredit] RPC error:', error.message)
    throw error
  }
  return data === true
}

/** How a reversal turned out. Mirrors reverse_user_credits' JSONB return. */
export interface CreditReversal {
  /** False when this refund id was already recorded — a Stripe redelivery. */
  applied: boolean
  reason: 'reversed' | 'dispute_recorded' | 'already_recorded' | 'blocked_uncredited'
  roomsReversed: number
  followUpsReversed: number
  /** Credits the customer had already spent and keeps. Money out, service delivered. */
  roomsShortfall: number
  followUpsShortfall: number
  needsReview: boolean
}

export interface ReverseCreditsInput {
  paymentId: string
  provider: 'stripe' | 'razorpay'
  /** The gateway's refund or dispute id. This is the idempotency key. */
  providerRefundId: string
  kind: 'refund' | 'dispute'
  rooms: number
  followUps: number
  amountMinor?: number
  currency?: string | null
  reason?: string | null
  disputeStatus?: string | null
}

/**
 * Reverses credits for a refund, or records a dispute without touching them.
 *
 * Everything that matters happens inside reverse_user_credits, under the
 * payment's row lock, for the same reason add_user_credits credits there: two
 * deliveries of one Stripe event race each other routinely, and both a "have we
 * already done this?" check and a balance read-then-subtract are wrong outside
 * the lock.
 *
 * Throws on RPC failure, so the caller can ask Stripe to redeliver. A refund
 * where the money went back and the credits stayed is the failure worth a retry.
 */
export async function reverseCreditsForPayment(input: ReverseCreditsInput): Promise<CreditReversal> {
  const db = getServiceClient()

  const { data, error } = await db.rpc('reverse_user_credits', {
    p_payment_id: input.paymentId,
    p_provider: input.provider,
    p_provider_refund_id: input.providerRefundId,
    p_kind: input.kind,
    p_rooms: input.rooms,
    p_follow_ups: input.followUps,
    p_amount_minor: input.amountMinor ?? 0,
    p_currency: input.currency ?? null,
    p_reason: input.reason ?? null,
    p_dispute_status: input.disputeStatus ?? null,
  })

  if (error) {
    console.error('[reverseCreditsForPayment] RPC error:', error.message)
    throw error
  }

  const row = (data ?? {}) as Record<string, unknown>
  return {
    applied: row['applied'] === true,
    reason: (row['reason'] as CreditReversal['reason']) ?? 'reversed',
    roomsReversed: Number(row['rooms_reversed'] ?? 0),
    followUpsReversed: Number(row['follow_ups_reversed'] ?? 0),
    roomsShortfall: Number(row['rooms_shortfall'] ?? 0),
    followUpsShortfall: Number(row['follow_ups_shortfall'] ?? 0),
    needsReview: row['needs_review'] === true,
  }
}

export const PRODUCTS = {
  '1_room': { label: '1 Room Pack', rooms: 1, followUps: 0, amountPaise: 19900 },
  '3_rooms': { label: '3 Room Pack', rooms: 3, followUps: 0, amountPaise: 49900 },
  '10_followups': { label: '10 Follow-up Pack', rooms: 0, followUps: 10, amountPaise: 19900 },
} as const

export type ProductKey = keyof typeof PRODUCTS
