import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { getEnv } from '@/lib/env'
import { requireMeetingSessionById, isAccessError } from '@/lib/meeting/getSession'
import { EmailReportRequestSchema, renderMeetingReportEmail } from '@/lib/meeting/reportEmail'
import { sendEmail, isEmailConfigured } from '@/lib/notifications/sendEmail'
import { trackMeetingEvent } from '@/lib/analytics/meetingEvents'
import { createClient } from '@/lib/supabase/server'

export const MEETING_REPORT_EMAILED = 'meeting_report_emailed'
/** Sends per case per hour. Each send carries up to MAX_RECIPIENTS addresses. */
const SENDS_PER_HOUR = 10

/**
 * Emails the completed meeting report, inline, to addresses the owner names.
 * Owner-only: the report belongs to the case owner, and sharing it is their
 * decision. Replies go to the owner, not to us.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const access = await requireMeetingSessionById(id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  if (!isEmailConfigured()) {
    return NextResponse.json({ error: 'email_not_configured', message: 'Email sending is not set up in this environment yet.' }, { status: 503 })
  }

  const report = access.session.final_report
  if (!report || access.session.status !== 'completed') {
    return NextResponse.json({ error: 'The report is not ready yet.' }, { status: 409 })
  }

  const body = await req.json().catch(() => null)
  const parsed = EmailReportRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.' }, { status: 400 })
  }

  const db = getServiceClient()

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count } = await db
    .from('audit_events')
    .select('id', { count: 'exact', head: true })
    .eq('case_id', access.caseId)
    .eq('event_type', MEETING_REPORT_EMAILED)
    .gte('created_at', since)
  if ((count ?? 0) >= SENDS_PER_HOUR) {
    return NextResponse.json({ error: 'Too many emails for this report in the last hour. Try again later.' }, { status: 429 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const senderEmail = user?.email ?? 'the meeting owner'

  const { data: participants } = await db
    .from('meeting_participants')
    .select('name')
    .eq('session_id', id)
    .order('participant_index')

  const { NEXT_PUBLIC_APP_URL } = getEnv()
  const email = renderMeetingReportEmail(report, {
    topic: access.session.topic,
    participantNames: (participants ?? []).map((p) => p.name),
    endedAt: access.session.ended_at,
    senderEmail,
    ...(parsed.data.note ? { note: parsed.data.note } : {}),
    appUrl: NEXT_PUBLIC_APP_URL,
  })

  const result = await sendEmail({
    to: parsed.data.recipients,
    subject: email.subject,
    html: email.html,
    text: email.text,
    ...(user?.email ? { replyTo: user.email } : {}),
  })

  if (!result.ok) {
    console.error('[meeting report email] send failed:', result.error)
    return NextResponse.json({ error: 'The email could not be sent. Please try again.' }, { status: 502 })
  }

  // Count only, never the addresses: audit_events is read by analytics.
  await trackMeetingEvent(db, { caseId: access.caseId, event: MEETING_REPORT_EMAILED, metadata: { recipients: parsed.data.recipients.length } })

  return NextResponse.json({ sent: parsed.data.recipients.length })
}
