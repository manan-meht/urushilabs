import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireMeetingSessionById, isAccessError } from '@/lib/meeting/getSession'

/** Backend-status-driven polling endpoint for the Meeting Mediation status page. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const access = await requireMeetingSessionById(id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  const db = getServiceClient()

  const { data: participants } = await db
    .from('meeting_participants')
    .select('id, participant_index, name, is_initiator, context_submitted_at, consented_at, invited_at')
    .eq('session_id', id)
    .order('participant_index')

  return NextResponse.json({
    session: {
      id: access.session.id,
      status: access.session.status,
      topic: access.session.topic,
      meetingPlatform: access.session.meeting_platform,
      meetingUrl: access.session.meeting_url,
      scheduledStartAt: access.session.scheduled_start_at,
      timezone: access.session.timezone,
      startNow: access.session.start_now,
      failureReason: access.session.failure_reason,
      finalReport: access.session.final_report,
    },
    participants: (participants ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      isInitiator: p.is_initiator,
      contextSubmitted: Boolean(p.context_submitted_at),
      consented: Boolean(p.consented_at),
      invited: Boolean(p.invited_at),
    })),
  })
}
