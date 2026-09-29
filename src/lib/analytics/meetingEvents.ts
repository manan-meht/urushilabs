/**
 * Meeting Mediation analytics + usage logging. Same pattern as
 * src/lib/analytics/roomEvents.ts — structured rows in `audit_events`, no
 * third-party analytics SDK. Kept as an independent file so Live Mediation's
 * analytics module is never touched by this work.
 */

import type { getServiceClient } from '@/lib/db/client'
import { costOf, ttsCostOf } from '@/lib/billing/modelCosts'

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
 * Records one increment of work against a meeting session's usage row.
 *
 * Every field is additive except duration and provider cost, which are set.
 * The write is a single RPC (record_meeting_usage, migration 023) so concurrent
 * webhooks cannot lose each other's updates: the previous read-modify-write
 * upsert raced Recall's end-of-meeting burst and every completed session ended
 * up with zero tokens and no duration.
 *
 * Costs are computed here from the model name so call sites pass what they
 * know (tokens, seconds) and pricing lives in one file. Never throws; usage
 * recording happens beside the mediation, not in its way.
 */
export async function recordMeetingUsage(
  db: ServiceClient,
  sessionId: string,
  delta: Partial<{
    model: string
    openaiInputTokens: number
    openaiCachedInputTokens: number
    openaiOutputTokens: number
    transcriptSegmentIncrement: number
    interventionIncrement: number
    /** Seconds of speech synthesised; priced at ttsModel's per-minute rate. */
    generatedAudioSeconds: number
    ttsModel: string
    meetingDurationSeconds: number
    /** Meeting-bot cost for the whole session; set, not added. */
    providerCostUsd: number
  }>
): Promise<void> {
  const inputTokens = delta.openaiInputTokens ?? 0
  const cachedInputTokens = delta.openaiCachedInputTokens ?? 0
  const outputTokens = delta.openaiOutputTokens ?? 0
  const openaiCost = delta.model
    ? costOf(delta.model, { inputTokens, outputTokens, cachedInputTokens })
    : 0
  const audioSeconds = delta.generatedAudioSeconds ?? 0
  const ttsCost = delta.ttsModel ? ttsCostOf(delta.ttsModel, audioSeconds) : 0

  try {
    const { error } = await db.rpc('record_meeting_usage', {
      p_session_id: sessionId,
      p_model: delta.model ?? null,
      p_input_tokens: inputTokens,
      p_cached_input_tokens: cachedInputTokens,
      p_output_tokens: outputTokens,
      p_openai_cost_usd: openaiCost,
      p_segments: delta.transcriptSegmentIncrement ?? 0,
      p_interventions: delta.interventionIncrement ?? 0,
      p_audio_seconds: audioSeconds,
      p_tts_cost_usd: ttsCost,
      p_duration_seconds: delta.meetingDurationSeconds !== undefined ? Math.round(delta.meetingDurationSeconds) : null,
      p_provider_cost_usd: delta.providerCostUsd ?? null,
    })
    if (error) console.error('[recordMeetingUsage] failed:', error.message)
  } catch (err) {
    console.error('[recordMeetingUsage] threw:', err instanceof Error ? err.message : err)
  }
}
