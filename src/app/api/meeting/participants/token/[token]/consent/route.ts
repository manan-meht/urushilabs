import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireMeetingParticipantByToken, isAccessError } from '@/lib/meeting/getSession'
import { MeetingConsentSchema } from '@/lib/validation/schemas'
import { trackMeetingEvent, MEETING_ANALYTICS_EVENTS } from '@/lib/analytics/meetingEvents'

/**
 * Records one participant's explicit consent (spec §11). Never inferred from
 * being invited or from submitting context — this is its own explicit step.
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

  const parsed = MeetingConsentSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  const db = getServiceClient()

  const { error } = await db.from('meeting_participants').update({
    consented_at: new Date().toISOString(),
  }).eq('id', access.participant.id)

  if (error) {
    console.error('[meeting/participants/consent] DB error:', error.message)
    return NextResponse.json({ error: 'Failed to record consent.' }, { status: 500 })
  }

  await trackMeetingEvent(db, { caseId: access.caseId, event: MEETING_ANALYTICS_EVENTS.PARTICIPANT_CONSENTED, metadata: { participantId: access.participant.id } })

  // If every participant has now consented, the session is ready for meeting details.
  const { data: allParticipants } = await db
    .from('meeting_participants')
    .select('consented_at')
    .eq('session_id', access.session.id)

  const allConsented = (allParticipants ?? []).every((p) => p.consented_at)
  if (allConsented && access.session.status === 'awaiting_preparation') {
    await db.from('meeting_sessions').update({ consent_completed_at: new Date().toISOString() }).eq('id', access.session.id)
  }

  return NextResponse.json({ ok: true })
}
