/**
 * Server-only: shared report-generation logic for Meeting Mediation, callable both
 * from the owner-authenticated /complete route and from the Recall webhook's
 * meeting_ended handler (which has no user session to authenticate with —
 * requireMeetingSessionById would fail there). Idempotent via final_report/status
 * short-circuits, same as Room Mode's /complete route.
 */

import { getServiceClient } from '@/lib/db/client'
import { generateMeetingFinalReport } from '@/lib/ai/meeting/finalReport'
import { trackMeetingEvent, MEETING_ANALYTICS_EVENTS, recordMeetingUsage } from '@/lib/analytics/meetingEvents'
import type { DbMeetingParticipant, DbMeetingSession, DbMeetingTranscriptSegment, MeetingFinalReport } from '@/lib/db/types'

export type CompleteMeetingSessionResult =
  | { ok: true; report: MeetingFinalReport }
  | { ok: false; error: string }

export async function completeMeetingSession(sessionId: string): Promise<CompleteMeetingSessionResult> {
  const db = getServiceClient()

  const { data: session } = await db.from('meeting_sessions').select('*').eq('id', sessionId).single()
  if (!session) return { ok: false, error: 'Session not found.' }
  const meetingSession = session as DbMeetingSession

  if (meetingSession.final_report) return { ok: true, report: meetingSession.final_report }

  if (!['ended', 'generating_report', 'in_meeting'].includes(meetingSession.status)) {
    return { ok: false, error: 'Session is not ready for a report yet.' }
  }

  await db.from('meeting_sessions').update({ status: 'generating_report' }).eq('id', sessionId)

  const [{ data: participants }, { data: issues }, { data: agreements }, { data: transcript }] = await Promise.all([
    db.from('meeting_participants').select('*').eq('session_id', sessionId).order('participant_index'),
    db.from('meeting_issues').select('title, status, resolution').eq('session_id', sessionId).order('priority'),
    db.from('meeting_agreements').select('description, confirmed').eq('session_id', sessionId).eq('confirmed', true),
    db.from('meeting_transcript_segments').select('*').eq('session_id', sessionId).order('sequence_number').limit(200),
  ])

  const participantList = (participants ?? []) as DbMeetingParticipant[]

  let result
  try {
    result = await generateMeetingFinalReport({
      topic: meetingSession.topic,
      contextSummary: meetingSession.context_summary ?? undefined,
      participantNames: participantList.map((p) => p.name),
      conversationSummary: meetingSession.conversation_summary ?? 'No summary was captured during the meeting.',
      issueResolutions: (issues ?? []).map((i) => ({ title: i.title, status: i.status, resolution: i.resolution ?? undefined })),
      confirmedAgreements: (agreements ?? []).map((a) => a.description),
      transcriptExcerpt: ((transcript ?? []) as DbMeetingTranscriptSegment[]).map((t) => ({
        speakerName: t.speaker_name ?? (t.role === 'assistant' ? 'Urushi' : 'Participant'),
        content: t.content,
      })),
    })
  } catch (err) {
    console.error('[completeMeetingSession] Final report generation failed:', err)
    await db.from('meeting_sessions').update({ status: 'ended' }).eq('id', sessionId)
    return { ok: false, error: 'Failed to generate final report.' }
  }

  const now = new Date().toISOString()
  await db.from('meeting_sessions').update({
    final_report: result.report,
    status: 'completed',
    ended_at: meetingSession.ended_at ?? now,
  }).eq('id', sessionId)

  await db.from('cases').update({ status: 'report_ready' }).eq('id', meetingSession.case_id)

  await recordMeetingUsage(db, sessionId, {
    openaiInputTokens: result.inputTokens,
    openaiOutputTokens: result.outputTokens,
    meetingDurationSeconds: meetingSession.joined_at
      ? (Date.now() - new Date(meetingSession.joined_at).getTime()) / 1000
      : undefined,
  })

  await trackMeetingEvent(db, { caseId: meetingSession.case_id, event: MEETING_ANALYTICS_EVENTS.REPORT_GENERATED })
  await trackMeetingEvent(db, { caseId: meetingSession.case_id, event: MEETING_ANALYTICS_EVENTS.COMPLETED })

  return { ok: true, report: result.report }
}
