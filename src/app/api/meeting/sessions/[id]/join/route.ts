import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireMeetingSessionById, isAccessError } from '@/lib/meeting/getSession'
import { getMeetingBotProvider } from '@/lib/meeting/providerFactory'
import { getEnv } from '@/lib/env'
import { trackMeetingEvent, MEETING_ANALYTICS_EVENTS } from '@/lib/analytics/meetingEvents'
import { MeetingProviderNotConfiguredError } from '@/lib/meeting/provider'

/**
 * Requests the meeting bot to join now (or schedules it for scheduled_start_at).
 * Idempotent: session.status is the guard against duplicate bot-join requests from
 * a double-click, retried request, or concurrent tab (spec §35) — once a session
 * has moved past 'ready', repeat calls are rejected rather than creating a second bot.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const access = await requireMeetingSessionById(id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  if (access.session.status !== 'ready') {
    if (['bot_requested', 'joining', 'waiting_room', 'in_meeting'].includes(access.session.status)) {
      return NextResponse.json({ status: access.session.status })
    }
    return NextResponse.json({ error: 'Add a meeting link before starting Urushi.' }, { status: 409 })
  }

  if (!access.session.meeting_url || !access.session.meeting_platform) {
    return NextResponse.json({ error: 'Add a meeting link before starting Urushi.' }, { status: 409 })
  }

  const db = getServiceClient()
  const provider = getMeetingBotProvider()

  if (!provider.isConfigured()) {
    return NextResponse.json(
      { error: 'not_configured', message: "Meeting connection isn't configured in this environment." },
      { status: 503 }
    )
  }

  const { RECALL_BOT_NAME, RECALL_WEBHOOK_URL, NEXT_PUBLIC_APP_URL } = getEnv()
  const webhookUrl = RECALL_WEBHOOK_URL || `${NEXT_PUBLIC_APP_URL}/api/integrations/recall/webhook`

  await db.from('meeting_sessions').update({ status: 'bot_requested', requested_at: new Date().toISOString() }).eq('id', id)
  await trackMeetingEvent(db, { caseId: access.caseId, event: MEETING_ANALYTICS_EVENTS.BOT_REQUESTED })

  try {
    const handle = access.session.start_now || !access.session.scheduled_start_at
      ? await provider.createBot({
          meetingUrl: access.session.meeting_url,
          platform: access.session.meeting_platform,
          botDisplayName: RECALL_BOT_NAME,
          idempotencyKey: access.session.id,
          webhookUrl,
        })
      : await provider.scheduleBot({
          meetingUrl: access.session.meeting_url,
          platform: access.session.meeting_platform,
          botDisplayName: RECALL_BOT_NAME,
          idempotencyKey: access.session.id,
          webhookUrl,
          joinAt: access.session.scheduled_start_at,
        })

    await db.from('meeting_sessions').update({
      provider_bot_id: handle.providerBotId,
      provider_meeting_id: handle.providerMeetingId ?? null,
      status: 'joining',
    }).eq('id', id)

    await trackMeetingEvent(db, { caseId: access.caseId, event: MEETING_ANALYTICS_EVENTS.BOT_JOINING, metadata: { providerBotId: handle.providerBotId } })

    return NextResponse.json({ status: 'joining', providerBotId: handle.providerBotId })
  } catch (err) {
    if (err instanceof MeetingProviderNotConfiguredError) {
      await db.from('meeting_sessions').update({ status: 'ready' }).eq('id', id)
      return NextResponse.json(
        { error: 'not_configured', message: "Meeting connection isn't configured in this environment." },
        { status: 503 }
      )
    }
    console.error('[POST meeting/join] provider error:', err)
    await db.from('meeting_sessions').update({
      status: 'failed',
      failure_reason: 'Urushi could not join the meeting.',
    }).eq('id', id)
    await trackMeetingEvent(db, { caseId: access.caseId, event: MEETING_ANALYTICS_EVENTS.FAILED, metadata: { stage: 'join' } })
    return NextResponse.json({ error: "Urushi couldn't join the meeting." }, { status: 502 })
  }
}
