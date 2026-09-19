/**
 * Server-only: resolve and validate a Room (Live Mediation) session by case reference
 * or session id. Mirrors src/lib/together/getSession.ts. Room Mode has no separate
 * per-participant identity in V1 — like Together Mode's shared-device path, every
 * participant is physically present around the one authenticated owner's device.
 */

import type { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { hashToken } from '@/lib/tokens'
import type { DbRoomSession } from '@/lib/db/types'

export interface RoomSessionAccess {
  session: DbRoomSession
  caseId: string
  userId: string
}

export async function requireRoomSession(reference: string): Promise<RoomSessionAccess | { error: string; status: number }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized.', status: 401 }

  const db = getServiceClient()

  const { data: caseRow } = await db
    .from('cases')
    .select('id, user_id, conversation_mode')
    .eq('public_reference', reference)
    .eq('conversation_mode', 'room')
    .single()

  if (!caseRow) return { error: 'Session not found.', status: 404 }
  if (caseRow.user_id !== user.id) return { error: 'Forbidden.', status: 403 }

  const { data: session } = await db
    .from('room_sessions')
    .select('*')
    .eq('case_id', caseRow.id)
    .single()

  if (!session) return { error: 'Session not found.', status: 404 }

  return { session: session as DbRoomSession, caseId: caseRow.id, userId: user.id }
}

/** Same check, keyed by room_sessions.id rather than the case's public reference. */
export async function requireRoomSessionById(sessionId: string): Promise<RoomSessionAccess | { error: string; status: number }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized.', status: 401 }

  const db = getServiceClient()

  const { data: session } = await db
    .from('room_sessions')
    .select('*, cases!room_sessions_case_id_fkey!inner(id, user_id)')
    .eq('id', sessionId)
    .single()

  if (!session) return { error: 'Session not found.', status: 404 }

  type S = typeof session & { cases: { id: string; user_id: string } }
  const caseRow = (session as S).cases
  if (caseRow.user_id !== user.id) return { error: 'Forbidden.', status: 403 }

  return { session: session as DbRoomSession, caseId: caseRow.id, userId: user.id }
}

/**
 * Device bearer-token auth — the non-browser equivalent of requireRoomSessionById,
 * for a paired hardware client (e.g. a Raspberry Pi) instead of the session owner's
 * browser cookie. Tokens are minted via POST /api/room/sessions/[id]/devices (owner
 * only) and never stored in plaintext — see supabase/migrations/011_room_device_auth.sql.
 */
export async function requireRoomSessionByDeviceToken(
  token: string,
  sessionId: string
): Promise<RoomSessionAccess | { error: string; status: number }> {
  const device = await resolveDeviceByToken(token)
  if (!device) return { error: 'Unauthorized.', status: 401 }

  // A device token grants access to exactly the session it is currently assigned
  // to, and nothing else. An idle device (session_id NULL) authenticates nothing.
  if (!device.sessionId || device.sessionId !== sessionId) return { error: 'Unauthorized.', status: 401 }

  const db = getServiceClient()
  const { data: session } = await db
    .from('room_sessions')
    .select('*, cases!room_sessions_case_id_fkey!inner(id, user_id)')
    .eq('id', sessionId)
    .single()

  if (!session) return { error: 'Session not found.', status: 404 }

  type S = typeof session & { cases: { id: string; user_id: string } }
  const caseRow = (session as S).cases

  return { session: session as DbRoomSession, caseId: caseRow.id, userId: caseRow.user_id }
}

export interface ResolvedDevice {
  id: string
  userId: string
  sessionId: string | null
}

/**
 * Resolves a device bearer token to the device itself, independent of any
 * session. Needed because a persistent device spends most of its life idle —
 * polling for an assignment it does not have yet — and must still be able to
 * authenticate to ask (see GET /api/room/device/assignment).
 *
 * Touches last_seen_at on every call, which is what makes the owner's ready
 * screen able to show a device as online without the device doing anything else.
 */
export async function resolveDeviceByToken(token: string): Promise<ResolvedDevice | null> {
  if (!token) return null

  const db = getServiceClient()
  const { data: device } = await db
    .from('room_devices')
    .select('id, user_id, session_id')
    .eq('device_token_hash', hashToken(token))
    .is('revoked_at', null)
    .single()

  if (!device) return null

  // Best-effort freshness tracking — never blocks the request.
  void db.from('room_devices').update({ last_seen_at: new Date().toISOString() }).eq('id', device.id)

  return { id: device.id, userId: device.user_id, sessionId: device.session_id }
}

/** Extracts a Bearer token from the request, or null if absent. */
export function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token || null
}

/**
 * Accepts EITHER a paired device's bearer token (Authorization: Bearer <token>) or
 * the owner's browser cookie — whichever the request presents. Used by the
 * live-session routes a hardware client needs to call (realtime-token, intervene,
 * calibrate, pause, resume, complete, status). Consent and agreement confirmation
 * deliberately stay owner/cookie-only (requireRoomSessionById) — those are
 * one-time human attestations, not ongoing session operations.
 */
export async function requireRoomSessionAccess(
  req: NextRequest,
  sessionId: string
): Promise<RoomSessionAccess | { error: string; status: number }> {
  const token = bearerToken(req)
  if (token) return requireRoomSessionByDeviceToken(token, sessionId)
  return requireRoomSessionById(sessionId)
}

export function isAccessError(v: unknown): v is { error: string; status: number } {
  return typeof v === 'object' && v !== null && 'error' in v && 'status' in v
}
