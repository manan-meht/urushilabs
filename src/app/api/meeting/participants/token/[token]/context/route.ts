import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireMeetingParticipantByToken, isAccessError } from '@/lib/meeting/getSession'
import { MeetingParticipantContextSchema } from '@/lib/validation/schemas'
import { encryptToDb } from '@/lib/crypto'
import { trackMeetingEvent, MEETING_ANALYTICS_EVENTS } from '@/lib/analytics/meetingEvents'

/**
 * Records a participant's private pre-meeting perspective — encrypted at rest
 * (same AES-256-GCM scheme as `submissions`), never disclosed verbatim during the
 * meeting (spec §6). No login required; the token itself is the credential.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  const access = await requireMeetingParticipantByToken(token)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const parsed = MeetingParticipantContextSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  const db = getServiceClient()
  const encrypted = encryptToDb(parsed.data.perspective)

  const { error } = await db.from('meeting_participants').update({
    encrypted_context: encrypted.encrypted_content,
    context_iv: encrypted.encryption_iv,
    context_tag: encrypted.encryption_tag,
    context_submitted_at: new Date().toISOString(),
  }).eq('id', access.participant.id)

  if (error) {
    console.error('[meeting/participants/context] DB error:', error.message)
    return NextResponse.json({ error: 'Failed to save your perspective.' }, { status: 500 })
  }

  await trackMeetingEvent(db, { caseId: access.caseId, event: MEETING_ANALYTICS_EVENTS.PARTICIPANT_CONTEXT_SUBMITTED, metadata: { participantId: access.participant.id } })

  return NextResponse.json({ ok: true })
}
