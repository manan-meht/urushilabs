/**
 * Persistence for meeting runtime state that survives concurrency.
 *
 * Three writers touch meeting_sessions.runtime_state during a meeting: the
 * webhook (speech_on/off, partials), the bot-status tile writer, and the
 * decision pipeline. Each used to read the whole object and write the whole
 * object back. The pipeline's copy was 20-30 seconds stale by the time it
 * wrote, so a live session with 65 speech events ended with an empty
 * speakingNow and no botStatus at all — the floor wait and the camera tile
 * were inert. Everything here goes through merge_meeting_runtime_state
 * (migration 024), which merges only the keys the writer owns.
 */

import type { getServiceClient } from '@/lib/db/client'
import type { RuntimeState } from './runtimeState'

type ServiceClient = ReturnType<typeof getServiceClient>

/**
 * A partial write. `speakingNow` is merged one level down: a number sets that
 * participant's speech_on time, null removes them (speech_off).
 */
export type RuntimeStatePatch = Partial<Omit<RuntimeState, 'speakingNow'>> & {
  speakingNow?: Record<string, number | null>
}

/** The keys the decision pipeline owns. Everything else belongs to the webhook or the tile. */
const CONTROLLER_KEYS = [
  'wordsBySpeaker',
  'interruptionCounts',
  'unansweredQuestions',
  'recentUtterances',
  'circularityScore',
  'escalationLevel',
  'urushiLastSpokeAt',
  'recentInterventions',
  'startedAt',
  'lastUtteranceAt',
] as const

/** Strips a full state down to the pipeline's own keys, so persisting it cannot clobber the floor or the tile. */
export function controllerFields(state: RuntimeState): RuntimeStatePatch {
  const out: Record<string, unknown> = {}
  for (const k of CONTROLLER_KEYS) {
    const v = (state as unknown as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = v
  }
  return out as RuntimeStatePatch
}

export function speakingPatch(providerParticipantId: string, speaking: boolean, at: number, partial = false): RuntimeStatePatch {
  return {
    speakingNow: { [providerParticipantId]: speaking ? at : null },
    ...(partial ? { lastPartialAt: at } : {}),
  }
}

/** Never throws: state persistence must not take down a turn. */
export async function mergeRuntimeState(db: ServiceClient, sessionId: string, patch: RuntimeStatePatch): Promise<void> {
  try {
    const { error } = await db.rpc('merge_meeting_runtime_state', { p_session_id: sessionId, p_patch: patch })
    if (error) console.error('[runtimeStateStore] merge failed:', error.message)
  } catch (err) {
    console.error('[runtimeStateStore] merge threw:', err instanceof Error ? err.message : err)
  }
}

/** Seconds a claim lasts if the holder never releases it (a crashed Worker). Longer than any pipeline run. */
export const DELIBERATION_TTL_SECONDS = 90

/**
 * Claims the right to run the decision pipeline for this session. FALSE means
 * another segment's pipeline is mid-flight; the caller has stored its segment
 * and the running pipeline re-reads the transcript before it speaks.
 */
export async function claimDeliberation(db: ServiceClient, sessionId: string): Promise<boolean> {
  const { data, error } = await db.rpc('claim_meeting_deliberation', {
    p_session_id: sessionId,
    p_ttl_seconds: DELIBERATION_TTL_SECONDS,
  })
  if (error) {
    // Fail open: a broken claim must not silence the mediator for the meeting.
    console.error('[runtimeStateStore] claim failed:', error.message)
    return true
  }
  return data === true
}

export async function releaseDeliberation(db: ServiceClient, sessionId: string): Promise<void> {
  const { error } = await db.from('meeting_sessions').update({ deliberating_until: null }).eq('id', sessionId)
  if (error) console.error('[runtimeStateStore] release failed:', error.message)
}

/** Atomic per-session counter. COUNT(*)+1 collided once segments arrived concurrently. */
export async function nextSequenceNumber(db: ServiceClient, sessionId: string): Promise<number> {
  const { data, error } = await db.rpc('next_meeting_sequence_number', { p_session_id: sessionId })
  if (error || typeof data !== 'number') {
    console.error('[runtimeStateStore] sequence RPC failed, falling back to count:', error?.message)
    const { count } = await db.from('meeting_transcript_segments').select('id', { count: 'exact', head: true }).eq('session_id', sessionId)
    return (count ?? 0) + 1
  }
  return data
}
