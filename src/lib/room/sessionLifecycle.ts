/**
 * Pure session-lifecycle helpers — stage/reconnect eligibility rules extracted so
 * they're unit-testable without spinning up WebRTC/DOM APIs.
 */

import type { RoomStage } from '@/lib/db/types'

export const RECONNECT_DELAYS_MS = [1000, 3000, 8000] as const

/** Returns the delay before the next reconnect attempt, or null once attempts are exhausted. */
export function getReconnectDelay(attempt: number): number | null {
  return RECONNECT_DELAYS_MS[attempt] ?? null
}

const LIVE_STAGES: ReadonlySet<RoomStage> = new Set(['live', 'paused'])

/** A session can only be explicitly ended while it's actually in progress. */
export function canEndSession(stage: RoomStage): boolean {
  return LIVE_STAGES.has(stage)
}

const STARTABLE_STAGES: ReadonlySet<RoomStage> = new Set(['ready', 'live', 'paused'])

/** Mirrors the guard in /api/room/sessions/[id]/realtime-token. */
export function canStartMediation(stage: RoomStage): boolean {
  return STARTABLE_STAGES.has(stage)
}
