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

export const PRODUCTS = {
  '1_room': { label: '1 Room Pack', rooms: 1, followUps: 0, amountPaise: 19900 },
  '3_rooms': { label: '3 Room Pack', rooms: 3, followUps: 0, amountPaise: 49900 },
  '10_followups': { label: '10 Follow-up Pack', rooms: 0, followUps: 10, amountPaise: 19900 },
} as const

export type ProductKey = keyof typeof PRODUCTS
