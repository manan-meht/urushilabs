/**
 * Server-only: works out WHO is accepting settings, from the caller's own
 * credentials.
 *
 * Never from the request body. If the client could name the accepting
 * participant, anyone with the case id could accept on everyone's behalf — which
 * would make the entire agreement flow decorative.
 *
 * Reuses each mode's existing participant authorization rather than inventing a
 * parallel one: the Supabase session cookie for the case owner, the Together
 * participant JWT for person B, and a hashed invite token for a meeting
 * participant who only ever has a link.
 */

import type { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { hashToken } from '@/lib/tokens'
import { getParticipantSession } from '@/lib/auth/togetherParticipantSession'
import { SHARED_DEVICE_REF } from './acceptance'

export interface AcceptingParticipant {
  ref: string
}

type Result = AcceptingParticipant | { error: string; status: number }

/**
 * Resolves the caller to a participant ref for this case.
 *
 * Order matters: an explicit participant credential (a meeting invite token, a
 * Together participant cookie) identifies a specific person and is checked
 * before falling back to the case owner's session.
 */
export async function resolveAcceptingParticipant(req: NextRequest, caseId: string): Promise<Result> {
  const db = getServiceClient()

  // 1. A meeting participant, identified by their emailed prep-link token.
  const token = req.headers.get('x-participant-token')
  if (token) {
    const { data: participant } = await db
      .from('meeting_participants')
      .select('id, case_id')
      .eq('invite_token_hash', hashToken(token))
      .maybeSingle()

    if (!participant || participant.case_id !== caseId) {
      return { error: 'Unauthorized.', status: 401 }
    }
    return { ref: participant.id as string }
  }

  // 2. Together's person B, who holds a participant JWT rather than an account.
  const togetherSession = await getParticipantSession()
  if (togetherSession) {
    const { data: session } = await db
      .from('together_sessions')
      .select('case_id')
      .eq('id', togetherSession.sessionId)
      .maybeSingle()

    if (!session || session.case_id !== caseId) {
      return { error: 'Unauthorized.', status: 401 }
    }
    return { ref: 'person_b' }
  }

  // 3. The case owner's own account.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized.', status: 401 }

  const { data: caseRow } = await db
    .from('cases')
    .select('id, user_id, conversation_mode')
    .eq('id', caseId)
    .maybeSingle()

  if (!caseRow) return { error: 'Not found.', status: 404 }
  if (caseRow.user_id !== user.id) return { error: 'Forbidden.', status: 403 }

  const mode = caseRow.conversation_mode as string

  // In shared-device modes the owner is confirming on behalf of everyone in the
  // room, so their acceptance IS the room's single acceptance.
  if (mode === 'room') return { ref: SHARED_DEVICE_REF }

  if (mode === 'together') {
    const { data: session } = await db
      .from('together_sessions')
      .select('device_mode')
      .eq('case_id', caseId)
      .maybeSingle()
    return { ref: session?.device_mode === 'separate' ? 'person_a' : SHARED_DEVICE_REF }
  }

  if (mode === 'meeting_mediation') {
    // The organiser is also a participant; match them to their own row so their
    // acceptance counts as a person's rather than an extra one.
    const { data: participant } = await db
      .from('meeting_participants')
      .select('id')
      .eq('case_id', caseId)
      .eq('is_initiator', true)
      .maybeSingle()

    if (participant) return { ref: participant.id as string }
  }

  // Invited mode: the owner is the initiator participant.
  const { data: initiator } = await db
    .from('participants')
    .select('id')
    .eq('case_id', caseId)
    .eq('role', 'initiator')
    .maybeSingle()

  if (initiator) return { ref: initiator.id as string }

  return { error: 'No participant record for this account.', status: 404 }
}
