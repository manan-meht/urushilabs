import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireMeetingSessionById, isAccessError } from '@/lib/meeting/getSession'
import { MeetingAgreementConfirmSchema } from '@/lib/validation/schemas'
import { affirmAgreement } from '@/lib/ai/meeting/meetingState'
import { trackMeetingEvent, MEETING_ANALYTICS_EVENTS } from '@/lib/analytics/meetingEvents'

/**
 * Manual affirmation endpoint — mainly for admin/diagnostic use and testing.
 * The primary path is automatic detection of spoken affirmation in
 * src/lib/meeting/pipeline.ts; this exists because agreement state must never
 * be confirmed without an explicit affirmation from every relevant participant
 * (spec §25), and a manual override is sometimes the only way to correct a
 * missed/misattributed spoken "yes".
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; agreementId: string }> }
) {
  const { id, agreementId } = await params

  const access = await requireMeetingSessionById(id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const parsed = MeetingAgreementConfirmSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  const db = getServiceClient()

  const { data: agreement } = await db
    .from('meeting_agreements')
    .select('*')
    .eq('id', agreementId)
    .eq('session_id', id)
    .single()

  if (!agreement) return NextResponse.json({ error: 'Agreement not found.' }, { status: 404 })

  const result = affirmAgreement(
    { agreedBy: (agreement.agreed_by ?? []) as string[], awaiting: (agreement.awaiting ?? []) as string[] },
    parsed.data.participantId
  )

  const { error } = await db.from('meeting_agreements').update({
    agreed_by: result.agreedBy,
    awaiting: result.awaiting,
    confirmed: result.confirmed,
    confirmed_at: result.confirmed ? new Date().toISOString() : null,
  }).eq('id', agreementId)

  if (error) {
    console.error('[meeting/agreements/confirm] DB error:', error.message)
    return NextResponse.json({ error: 'Failed to record confirmation.' }, { status: 500 })
  }

  if (result.confirmed) {
    await trackMeetingEvent(db, { caseId: access.caseId, event: MEETING_ANALYTICS_EVENTS.AGREEMENT_CONFIRMED, metadata: { agreementId } })
  }

  return NextResponse.json({ confirmed: result.confirmed, agreedBy: result.agreedBy, awaiting: result.awaiting })
}
