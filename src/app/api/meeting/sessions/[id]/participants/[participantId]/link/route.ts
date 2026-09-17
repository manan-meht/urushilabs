import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireMeetingSessionById, isAccessError } from '@/lib/meeting/getSession'
import { generateSecureToken, hashToken } from '@/lib/tokens'
import { getEnv } from '@/lib/env'

/**
 * Mints a fresh preparation-link token for a participant and returns the raw
 * link. Only the hash is ever persisted (same pattern as case invitations), so
 * regenerating is the only way for the owner to retrieve/re-share a link after
 * the initial invite email — mirrors admin's "regenerate invite" flow for
 * invited-mode cases.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; participantId: string }> }
) {
  const { id, participantId } = await params

  const access = await requireMeetingSessionById(id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  const db = getServiceClient()

  const { data: participant } = await db
    .from('meeting_participants')
    .select('id, session_id, is_initiator')
    .eq('id', participantId)
    .single()

  if (!participant || participant.session_id !== id) {
    return NextResponse.json({ error: 'Participant not found.' }, { status: 404 })
  }

  const token = generateSecureToken()
  const { error } = await db.from('meeting_participants').update({
    invite_token_hash: hashToken(token),
  }).eq('id', participantId)

  if (error) {
    console.error('[meeting/participants/link] DB error:', error.message)
    return NextResponse.json({ error: 'Failed to generate link.' }, { status: 500 })
  }

  const { NEXT_PUBLIC_APP_URL } = getEnv()
  return NextResponse.json({ link: `${NEXT_PUBLIC_APP_URL}/meeting/prepare/${token}` })
}
