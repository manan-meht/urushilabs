import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireMeetingSessionById, isAccessError } from '@/lib/meeting/getSession'
import { UpdateMeetingDetailsSchema, detectMeetingPlatform } from '@/lib/validation/schemas'
import { trackMeetingEvent, MEETING_ANALYTICS_EVENTS } from '@/lib/analytics/meetingEvents'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const access = await requireMeetingSessionById(id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  if (!['setup', 'awaiting_preparation', 'ready'].includes(access.session.status)) {
    return NextResponse.json({ error: 'Meeting details can no longer be changed for this session.' }, { status: 409 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const parsed = UpdateMeetingDetailsSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  const platform = detectMeetingPlatform(parsed.data.meetingUrl)
  if (!platform) {
    return NextResponse.json({ errors: { meetingUrl: ['Please enter a valid Google Meet or Zoom link.'] } }, { status: 422 })
  }

  const db = getServiceClient()

  const { error } = await db.from('meeting_sessions').update({
    meeting_platform: platform,
    meeting_url: parsed.data.meetingUrl,
    scheduled_start_at: parsed.data.scheduledStartAt ?? null,
    timezone: parsed.data.timezone ?? null,
    start_now: parsed.data.startNow,
    status: 'ready',
  }).eq('id', id)

  if (error) {
    console.error('[PATCH meeting/details] DB error:', error.message)
    return NextResponse.json({ error: 'Failed to save meeting details.' }, { status: 500 })
  }

  await trackMeetingEvent(db, { caseId: access.caseId, event: MEETING_ANALYTICS_EVENTS.MEETING_LINK_ADDED, metadata: { platform } })

  return NextResponse.json({ status: 'ready', meetingPlatform: platform })
}
