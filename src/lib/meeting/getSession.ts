/**
 * Server-only: resolve and validate a Meeting Mediation session, either by the
 * case's public reference (owner-facing pages) or by meeting_sessions.id (API
 * routes), and separately by a participant's invite token (public participant
 * preparation link — no account required, mirrors the 'invited' mode's
 * token-based access rather than Together Mode's JWT-cookie participant session,
 * since this is a one-shot preparation step, not an ongoing shared conversation).
 */

import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { hashToken, isTokenExpired } from '@/lib/tokens'
import type { DbMeetingParticipant, DbMeetingSession } from '@/lib/db/types'

export interface MeetingSessionAccess {
  session: DbMeetingSession
  caseId: string
  userId: string
}

export async function requireMeetingSession(reference: string): Promise<MeetingSessionAccess | { error: string; status: number }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized.', status: 401 }

  const db = getServiceClient()

  const { data: caseRow } = await db
    .from('cases')
    .select('id, user_id, conversation_mode')
    .eq('public_reference', reference)
    .eq('conversation_mode', 'meeting_mediation')
    .single()

  if (!caseRow) return { error: 'Session not found.', status: 404 }
  if (caseRow.user_id !== user.id) return { error: 'Forbidden.', status: 403 }

  const { data: session } = await db
    .from('meeting_sessions')
    .select('*')
    .eq('case_id', caseRow.id)
    .single()

  if (!session) return { error: 'Session not found.', status: 404 }

  return { session: session as DbMeetingSession, caseId: caseRow.id, userId: user.id }
}

/** Same check, keyed by meeting_sessions.id — named FK hint avoids the
 * ambiguous-embed pitfall Live Mediation hit when a table has multiple FKs to
 * `cases` (meeting_sessions only has one, but this keeps the pattern consistent
 * and future-proof if a source-case link is added later). */
export async function requireMeetingSessionById(sessionId: string): Promise<MeetingSessionAccess | { error: string; status: number }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized.', status: 401 }

  const db = getServiceClient()

  const { data: session } = await db
    .from('meeting_sessions')
    .select('*, cases!meeting_sessions_case_id_fkey!inner(id, user_id)')
    .eq('id', sessionId)
    .single()

  if (!session) return { error: 'Session not found.', status: 404 }

  type S = typeof session & { cases: { id: string; user_id: string } }
  const caseRow = (session as S).cases
  if (caseRow.user_id !== user.id) return { error: 'Forbidden.', status: 403 }

  return { session: session as DbMeetingSession, caseId: caseRow.id, userId: user.id }
}

export interface MeetingParticipantTokenAccess {
  participant: DbMeetingParticipant
  session: DbMeetingSession
  caseId: string
}

/** Resolves a participant's preparation-link token. No account/login required. */
export async function requireMeetingParticipantByToken(
  token: string
): Promise<MeetingParticipantTokenAccess | { error: string; status: number }> {
  if (!token) return { error: 'Invalid link.', status: 400 }

  const db = getServiceClient()
  const tokenHash = hashToken(token)

  const { data: participant } = await db
    .from('meeting_participants')
    .select('*')
    .eq('invite_token_hash', tokenHash)
    .single()

  if (!participant) return { error: 'This link is invalid or has expired.', status: 404 }

  const { data: session } = await db
    .from('meeting_sessions')
    .select('*')
    .eq('id', (participant as DbMeetingParticipant).session_id)
    .single()

  if (!session) return { error: 'Session not found.', status: 404 }

  const inviteExpiry = (session as DbMeetingSession).created_at
  // Preparation links share the same expiry policy as case invitations (7 days) —
  // computed from session creation rather than a stored per-participant expiry.
  const expiresAt = new Date(new Date(inviteExpiry).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
  if (isTokenExpired(expiresAt)) return { error: 'This link has expired.', status: 410 }

  return {
    participant: participant as DbMeetingParticipant,
    session: session as DbMeetingSession,
    caseId: (session as DbMeetingSession).case_id,
  }
}

export function isAccessError(v: unknown): v is { error: string; status: number } {
  return typeof v === 'object' && v !== null && 'error' in v && 'status' in v
}
