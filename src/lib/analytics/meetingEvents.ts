/**
 * Meeting Mediation analytics + usage logging. Same pattern as
 * src/lib/analytics/roomEvents.ts — structured rows in `audit_events`, no
 * third-party analytics SDK. Kept as an independent file so Live Mediation's
 * analytics module is never touched by this work.
 */

import type { getServiceClient } from '@/lib/db/client'

type ServiceClient = ReturnType<typeof getServiceClient>

export const MEETING_ANALYTICS_EVENTS = {
  SELECTED: 'meeting_mediation_selected',
  CREATED: 'meeting_mediation_created',
  PARTICIPANT_INVITED: 'participant_invited',
  PARTICIPANT_CONTEXT_SUBMITTED: 'participant_context_submitted',
  PARTICIPANT_CONSENTED: 'meeting_participant_consented',
  MEETING_LINK_ADDED: 'meeting_link_added',
  BOT_REQUESTED: 'meeting_bot_requested',
  BOT_JOINING: 'meeting_bot_joining',
  BOT_WAITING_ROOM: 'meeting_bot_waiting_room',
  BOT_JOINED: 'meeting_bot_joined',
  STARTED: 'meeting_mediation_started',
  INTERVENTION: 'meeting_intervention',
  /** Engine wanted to speak but a threshold/budget/cooldown suppressed it (spec §25). */
  INTERVENTION_SUPPRESSED: 'meeting_intervention_suppressed',
  /** A participant told Urushi to back off or step in (spec §14). */
  OVERRIDE_COMMAND: 'meeting_override_command',
  AGREEMENT_CONFIRMED: 'meeting_agreement_confirmed',
  BOT_DISCONNECTED: 'meeting_bot_disconnected',
  COMPLETED: 'meeting_mediation_completed',
  REPORT_GENERATED: 'meeting_report_generated',
  FAILED: 'meeting_mediation_failed',
} as const

export type MeetingAnalyticsEventName = typeof MEETING_ANALYTICS_EVENTS[keyof typeof MEETING_ANALYTICS_EVENTS]

/** Fire-and-forget-friendly event logger. Never throws. */
export async function trackMeetingEvent(
  db: ServiceClient,
  opts: { caseId: string; event: MeetingAnalyticsEventName | string; metadata?: Record<string, unknown> }
): Promise<void> {
  const { error } = await db.from('audit_events').insert({
    case_id: opts.caseId,
    event_type: opts.event,
    metadata: opts.metadata ?? null,
  })
  if (error) console.error('[trackMeetingEvent] failed to log event:', opts.event, error.message)
}

/**
 * Usage/cost accounting hook (spec §39) — upserts into meeting_usage. Internal
 * only; never surfaced to customers. Safe to call incrementally throughout a
 * session (e.g. once per intervention, once at completion for duration/tokens).
 */
export async function recordMeetingUsage(
  db: ServiceClient,
  sessionId: string,
  delta: Partial<{
    meetingDurationSeconds: number
    transcriptSegmentIncrement: number
    interventionIncrement: number
    openaiInputTokens: number
    openaiOutputTokens: number
    generatedAudioSeconds: number
  }>
): Promise<void> {
  const { data: existing } = await db
    .from('meeting_usage')
    .select('*')
    .eq('session_id', sessionId)
    .single()

  const current = existing ?? {
    session_id: sessionId,
    meeting_duration_seconds: null,
    transcript_segment_count: 0,
    intervention_count: 0,
    openai_input_tokens: 0,
    openai_output_tokens: 0,
    generated_audio_seconds: 0,
  }

  const { error } = await db.from('meeting_usage').upsert({
    session_id: sessionId,
    meeting_duration_seconds: delta.meetingDurationSeconds ?? current.meeting_duration_seconds,
    transcript_segment_count: current.transcript_segment_count + (delta.transcriptSegmentIncrement ?? 0),
    intervention_count: current.intervention_count + (delta.interventionIncrement ?? 0),
    openai_input_tokens: current.openai_input_tokens + (delta.openaiInputTokens ?? 0),
    openai_output_tokens: current.openai_output_tokens + (delta.openaiOutputTokens ?? 0),
    generated_audio_seconds: current.generated_audio_seconds + (delta.generatedAudioSeconds ?? 0),
  })

  if (error) console.error('[recordMeetingUsage] failed to upsert usage:', error.message)
}
