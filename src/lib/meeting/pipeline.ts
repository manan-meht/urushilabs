/**
 * Server-only: the realtime mediation pipeline for Meeting Mediation — the glue
 * between normalized provider events (src/lib/meeting/provider.ts) and the
 * mediation engine (src/lib/ai/meeting/*). This is the "normalized transcript →
 * Urushi Mediation Controller → LISTEN or intervention → response generator →
 * MeetingBotProvider" chain described in the architecture spec. Nothing here
 * knows about Recall specifically — it only calls MeetingBotProvider methods.
 *
 * Called from the webhook route (src/app/api/integrations/recall/webhook) for
 * each transcript_segment event, and reusable directly from tests with fixture
 * transcripts (see meetingPipeline.test.ts).
 */

import { getServiceClient } from '@/lib/db/client'
import { decryptFromDb } from '@/lib/crypto'
import { getMeetingBotProvider } from './providerFactory'
import { synthesizeSpeech } from '@/lib/ai/voice'
import type {
  MeetingTranscriptEntry,
  ParticipantPerspective,
} from '@/lib/ai/meeting/mediationController'
import {
  decideIntervention,
  generateInterventionSpeech,
  type EngineContext,
  type InterventionDecision,
} from '@/lib/ai/meeting/interventionEngine'
import { getVoiceProfile } from '@/lib/ai/meeting/voiceProfile'
import {
  applyOverride,
  detectOverrideCommand,
  resolveOverride,
} from '@/lib/ai/meeting/overrideCommands'
import { getEffectiveSettings } from '@/lib/conversation/getSettings'
import {
  meetingOnlyAgentSettingsFromRow,
  withConversationSettings,
  type InterventionReason,
  type MeetingAgentSettings,
} from '@/lib/meeting/agentSettings'
import {
  parseRuntimeState,
  recordIntervention,
  updateRuntimeState,
  type RuntimeState,
} from '@/lib/meeting/runtimeState'
import { isTrivialUtterance } from '@/lib/ai/meeting/interventionGuardrails'
import { trackMeetingEvent, MEETING_ANALYTICS_EVENTS, recordMeetingUsage } from '@/lib/analytics/meetingEvents'
import { affirmAgreement } from '@/lib/ai/meeting/meetingState'
import type { DbMeetingParticipant, DbMeetingSession, MeetingInterventionAction } from '@/lib/db/types'

type ServiceClient = ReturnType<typeof getServiceClient>

export interface IngestTranscriptInput {
  sessionId: string
  providerParticipantId: string | null
  speakerName: string | null
  content: string
  startedAt: string | null
  endedAt: string | null
  confidence: number | null
}

/** A trivial one-word affirmation used to detect (heuristically) agreement affirmation. */
const AFFIRMATION_PATTERN = /^(yes|yeah|yep|yup|agreed?|sounds good|works for me|ok(ay)?|sure|fine)[.!?]?$/i

export const MEETING_INTRODUCTION = `Hi everyone, I'm Urushi. I'll help keep this conversation focused, fair, and moving toward a real resolution — including saying plainly when I think one of you has the stronger case. Let's begin whenever you're ready.`

export async function ingestMeetingTranscriptSegment(input: IngestTranscriptInput): Promise<void> {
  const db = getServiceClient()

  const { data: session } = await db
    .from('meeting_sessions')
    .select('*')
    .eq('id', input.sessionId)
    .single()

  if (!session) return
  const meetingSession = session as DbMeetingSession
  if (meetingSession.status !== 'in_meeting') return

  const { data: participants } = await db
    .from('meeting_participants')
    .select('*')
    .eq('session_id', input.sessionId)
    .order('participant_index')

  const participantList = (participants ?? []) as DbMeetingParticipant[]
  const matchedParticipant = input.providerParticipantId
    ? participantList.find((p) => p.provider_participant_id === input.providerParticipantId)
    : undefined

  // Best-effort name mapping — if the provider can't tell us who spoke, do not
  // silently guess which Urushi participant it was (spec §17).
  const speakerName = matchedParticipant?.name ?? input.speakerName ?? 'Unknown speaker'

  // Recall's meeting-captions transcription hears the room, which includes
  // Urushi's own synthesized audio. Left unfiltered, Urushi ingests its own
  // words as an unidentified participant — inflating speaking time, polluting
  // circularity detection, and letting it react to itself. Drop those here.
  if (await isEchoOfUrushi(db, input.sessionId, input.content)) return

  const { count } = await db
    .from('meeting_transcript_segments')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', input.sessionId)

  const sequenceNumber = (count ?? 0) + 1

  await db.from('meeting_transcript_segments').insert({
    session_id: input.sessionId,
    case_id: meetingSession.case_id,
    participant_id: matchedParticipant?.id ?? null,
    provider_participant_id: input.providerParticipantId,
    speaker_name: speakerName,
    role: 'participant',
    content: input.content,
    sequence_number: sequenceNumber,
    confidence: input.confidence,
    started_at: input.startedAt,
    ended_at: input.endedAt,
  })

  await recordMeetingUsage(db, input.sessionId, { transcriptSegmentIncrement: 1 })

  // Heuristic agreement-affirmation detection: a trivial "yes"-style reply from an
  // identified participant, while a proposed-but-unconfirmed agreement is awaiting
  // them, counts as affirmation. Never inferred from silence or from an
  // unidentified speaker (spec §25).
  if (matchedParticipant && isTrivialUtterance(input.content) && AFFIRMATION_PATTERN.test(input.content.trim())) {
    await tryAffirmPendingAgreement(db, input.sessionId, meetingSession.case_id, matchedParticipant.id)
  }

  await runMediationController(db, meetingSession, participantList, {
    speakerName,
    content: input.content,
  })
}

/** Normalizes for echo comparison: case, punctuation and spacing all vary in ASR output. */
function normalizeForEcho(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * True when an incoming transcript chunk is (part of) something Urushi itself just
 * said. Transcription splits Urushi's speech into fragments and garbles words, so
 * this compares against recent assistant turns by substring containment on a
 * normalized form rather than requiring an exact match.
 */
export async function isEchoOfUrushi(
  db: ServiceClient,
  sessionId: string,
  content: string
): Promise<boolean> {
  const normalized = normalizeForEcho(content)
  // Very short fragments are matched too easily by chance; let them through and
  // let the trivial-utterance guard deal with them.
  if (normalized.split(' ').length < 4) return false

  const { data: recentUrushi } = await db
    .from('meeting_transcript_segments')
    .select('content')
    .eq('session_id', sessionId)
    .eq('role', 'assistant')
    .order('sequence_number', { ascending: false })
    .limit(3)

  return ((recentUrushi ?? []) as Array<{ content: string }>).some((row) => {
    const spoken = normalizeForEcho(row.content)
    return spoken.includes(normalized) || normalized.includes(spoken)
  })
}

async function tryAffirmPendingAgreement(
  db: ServiceClient,
  sessionId: string,
  caseId: string,
  participantId: string
): Promise<void> {
  const { data: pending } = await db
    .from('meeting_agreements')
    .select('*')
    .eq('session_id', sessionId)
    .eq('confirmed', false)
    .order('proposed_at', { ascending: false })
    .limit(1)
    .single()

  if (!pending) return
  const awaiting = (pending.awaiting ?? []) as string[]
  if (!awaiting.includes(participantId)) return

  const result = affirmAgreement(
    { agreedBy: (pending.agreed_by ?? []) as string[], awaiting },
    participantId
  )

  await db.from('meeting_agreements').update({
    agreed_by: result.agreedBy,
    awaiting: result.awaiting,
    confirmed: result.confirmed,
    confirmed_at: result.confirmed ? new Date().toISOString() : null,
  }).eq('id', pending.id)

  if (result.confirmed) {
    await trackMeetingEvent(db, { caseId, event: MEETING_ANALYTICS_EVENTS.AGREEMENT_CONFIRMED, metadata: { agreementId: pending.id } })
  }
}
/**
 * Runs the intervention engine for one incoming utterance and, if it decides to
 * speak, produces and delivers the intervention.
 *
 * The expensive work is deliberately behind a pure pre-gate (see
 * src/lib/ai/meeting/interventionEngine.ts) — most utterances in a healthy
 * meeting cost zero model calls.
 */
async function runMediationController(
  db: ServiceClient,
  session: DbMeetingSession,
  participants: DbMeetingParticipant[],
  latest: MeetingTranscriptEntry
): Promise<void> {
  const startedAt = Date.now()
  // Personality/language/profanity are agreed for the whole conversation and
  // stored on the case; the meeting row only supplies voice, region and how
  // often to interrupt.
  const conversationSettings = await getEffectiveSettings(session.case_id as string)
  const settings = withConversationSettings(
    meetingOnlyAgentSettingsFromRow(session as unknown as Record<string, unknown>),
    conversationSettings,
  )

  const { data: recentRows } = await db
    .from('meeting_transcript_segments')
    .select('speaker_name, content, role')
    .eq('session_id', session.id)
    .order('sequence_number', { ascending: false })
    .limit(21)

  const recentTranscript = ((recentRows ?? []) as Array<{ speaker_name: string | null; content: string; role: string }>)
    .reverse()
    .slice(0, -1) // exclude the just-inserted latest row
    .map((r) => ({
      speaker: r.speaker_name ?? (r.role === 'assistant' ? 'Urushi' : 'Unknown'),
      text: r.content,
    }))

  // ── Human overrides (spec §14) ─────────────────────────────────────────────
  // Checked before anything expensive: an explicit "Urushi, hold on" must take
  // effect on this very utterance, not the next one.
  let override = resolveOverride({
    mode: (session as unknown as { participation_override?: string | null }).participation_override,
    expiresAt: (session as unknown as { participation_override_expires_at?: string | null }).participation_override_expires_at,
  })

  const detected = detectOverrideCommand(latest.content)
  if (detected) {
    override = applyOverride(detected)
    await db.from('meeting_sessions').update({
      participation_override: override.mode,
      participation_override_expires_at: override.expiresAt ? new Date(override.expiresAt).toISOString() : null,
    }).eq('id', session.id)
    await trackMeetingEvent(db, {
      caseId: session.case_id,
      event: MEETING_ANALYTICS_EVENTS.OVERRIDE_COMMAND,
      metadata: { mode: override.mode },
    })
  }

  // ── Runtime state (spec §9) ────────────────────────────────────────────────
  const previousState = parseRuntimeState((session as unknown as { runtime_state?: unknown }).runtime_state)
  let state = updateRuntimeState(previousState, {
    speaker: latest.speakerName,
    text: latest.content,
  })

  const perspectives: ParticipantPerspective[] = participants
    .filter((p) => p.encrypted_context && p.context_iv && p.context_tag)
    .map((p) => {
      try {
        return {
          participantName: p.name,
          perspective: decryptFromDb({
            encrypted_content: p.encrypted_context!,
            encryption_iv: p.context_iv!,
            encryption_tag: p.context_tag!,
          }),
        }
      } catch {
        return null
      }
    })
    .filter((p): p is ParticipantPerspective => p !== null)

  const ctx: EngineContext = {
    settings,
    state,
    override,
    topic: session.topic,
    ...(session.context_summary ? { contextSummary: session.context_summary } : {}),
    participantNames: participants.map((p) => p.name),
    latestUtterance: { speaker: latest.speakerName, text: latest.content },
    recentTranscript,
    ...(perspectives.length > 0 ? { perspectives } : {}),
  }

  // ── Stage A: should Urushi speak at all? ───────────────────────────────────
  let decision: InterventionDecision
  try {
    decision = await decideIntervention(ctx)
  } catch (err) {
    console.error('[meeting pipeline] intervention decision failed:', err)
    await persistRuntimeState(db, session.id, state)
    return
  }

  if (!decision.shouldIntervene) {
    // Record near-misses so thresholds can be tuned against real meetings
    // (spec §25). Only worth storing when the engine actually deliberated —
    // trivial utterances would otherwise flood the table.
    if (decision.suppressedBy && decision.suppressedBy !== 'trivial' && decision.confidence > 0) {
      await db.from('meeting_interventions').insert({
        session_id: session.id,
        case_id: session.case_id,
        action: 'LISTEN',
        reasoning: `Suppressed by ${decision.suppressedBy}`,
        spoken_text: null,
        intervention_reason: decision.reason ?? null,
        intervention_style: decision.style,
        urgency: decision.urgency,
        confidence: decision.confidence,
        latency_ms: Date.now() - startedAt,
        suppressed: true,
      })
    }
    await persistRuntimeState(db, session.id, state)
    return
  }

  // ── Stage B: what does Urushi actually say? ────────────────────────────────
  let spokenText: string
  try {
    spokenText = await generateInterventionSpeech(ctx, decision)
  } catch (err) {
    console.error('[meeting pipeline] intervention speech failed:', err)
    await persistRuntimeState(db, session.id, state)
    return
  }

  const reason = decision.reason!
  await db.from('meeting_interventions').insert({
    session_id: session.id,
    case_id: session.case_id,
    action: interventionReasonToAction(reason),
    reasoning: decision.intendedOutcome ?? `Intervened: ${reason}`,
    spoken_text: spokenText,
    intervention_reason: reason,
    intervention_style: decision.style,
    urgency: decision.urgency,
    confidence: decision.confidence,
    latency_ms: Date.now() - startedAt,
    suppressed: false,
  })

  await recordMeetingUsage(db, session.id, { interventionIncrement: 1 })
  await trackMeetingEvent(db, {
    caseId: session.case_id,
    event: MEETING_ANALYTICS_EVENTS.INTERVENTION,
    metadata: { reason, style: decision.style, urgency: decision.urgency, personality: settings.personality },
  })

  // Issue tracking — the report is built from these, so they must be written
  // even though the engine's vocabulary is reasons rather than actions.
  if (reason === 'AGENDA_DRIFT' || reason === 'CLARIFICATION_NEEDED' || reason === 'FACT_VS_INTERPRETATION') {
    await ensureCurrentIssue(db, session, decision.intendedOutcome ?? reason)
  }
  if (reason === 'HIDDEN_AGREEMENT' || reason === 'DECISION_READY') {
    await db.from('meeting_agreements').insert({
      session_id: session.id,
      case_id: session.case_id,
      issue_id: session.current_issue_id,
      description: decision.intendedOutcome ?? spokenText,
      agreed_by: [],
      awaiting: participants.map((p) => p.id),
    })
  }
  if (reason === 'NEXT_STEP_NEEDED' || reason === 'DECISION_READY') {
    await db.from('meeting_sessions')
      .update({ conversation_summary: spokenText })
      .eq('id', session.id)
  }

  await db.from('meeting_transcript_segments').insert({
    session_id: session.id,
    case_id: session.case_id,
    participant_id: null,
    provider_participant_id: null,
    speaker_name: 'Urushi',
    role: 'assistant',
    content: spokenText,
    sequence_number: await nextSequenceNumber(db, session.id),
    intervention_reason: reason,
    intervention_style: decision.style,
  })

  state = recordIntervention(state, { reason, style: decision.style, at: Date.now() })
  await persistRuntimeState(db, session.id, state)

  await speakInMeeting(session, spokenText, settings)
}

/**
 * Bridges the engine's InterventionReason vocabulary onto the meeting_interventions
 * action enum, which predates the engine and is still used by reporting.
 */
function interventionReasonToAction(reason: InterventionReason): MeetingInterventionAction {
  switch (reason) {
    case 'ESCALATION':
    case 'PERSONAL_ATTACK':
      return 'DEESCALATE'
    case 'CLARIFICATION_NEEDED':
    case 'FACT_VS_INTERPRETATION':
      return 'CLARIFY'
    case 'PARTICIPANT_INTERRUPTED':
    case 'DOMINATING_PARTICIPANT':
      return 'INVITE_PARTICIPANT'
    case 'CIRCULAR_DISCUSSION':
    case 'AGENDA_DRIFT':
      return 'REFRAME'
    case 'EMOTIONAL_ISSUE':
    case 'CONTRADICTION':
    case 'UNANSWERED_QUESTION':
    case 'VAGUENESS':
    case 'UNSUPPORTED_CLAIM':
      return 'CLARIFY'
    case 'HIDDEN_AGREEMENT':
      return 'PROPOSE_COMPROMISE'
    case 'DECISION_READY':
      return 'CONFIRM_AGREEMENT'
    case 'NEXT_STEP_NEEDED':
      return 'SUMMARIZE'
    default:
      return 'CLARIFY'
  }
}

async function ensureCurrentIssue(
  db: ServiceClient,
  session: DbMeetingSession,
  title: string
): Promise<void> {
  if (session.current_issue_id) return
  const { count } = await db
    .from('meeting_issues')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', session.id)
  const { data: issueRow } = await db
    .from('meeting_issues')
    .insert({
      session_id: session.id,
      case_id: session.case_id,
      title: title.slice(0, 120),
      neutral_description: title,
      priority: (count ?? 0) + 1,
      status: 'discussing',
    })
    .select('id')
    .single()
  if (issueRow) {
    await db.from('meeting_sessions').update({ current_issue_id: issueRow.id }).eq('id', session.id)
  }
}

async function persistRuntimeState(db: ServiceClient, sessionId: string, state: RuntimeState): Promise<void> {
  const { error } = await db.from('meeting_sessions').update({ runtime_state: state }).eq('id', sessionId)
  if (error) console.error('[meeting pipeline] failed to persist runtime state:', error.message)
}

async function nextSequenceNumber(db: ServiceClient, sessionId: string): Promise<number> {
  const { count } = await db
    .from('meeting_transcript_segments')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
  return (count ?? 0) + 1
}

/**
 * Sends Urushi's spoken intervention back into the meeting via whatever the
 * active MeetingBotProvider supports: real speech via OpenAI TTS + Recall's
 * output_audio (clip-trigger, see RecallMeetingBotProvider module comment on
 * output_audio vs. the lower-latency output_media path), plus a chat message
 * as a visible fallback/transcript. TTS failure never blocks the chat message
 * — if audio synthesis or delivery fails, Urushi still gets heard in text
 * rather than silently saying nothing (spec §22 still holds: never fake
 * delivery, but a partial delivery is better than none).
 */
export async function speakInMeeting(
  session: DbMeetingSession,
  spokenText: string,
  settings?: MeetingAgentSettings
): Promise<void> {
  const provider = getMeetingBotProvider()
  if (!provider.isConfigured() || !session.provider_bot_id) return

  const resolved = settings ?? withConversationSettings(
    meetingOnlyAgentSettingsFromRow(session as unknown as Record<string, unknown>),
    await getEffectiveSettings(session.case_id as string),
  )
  const voiceProfile = getVoiceProfile(resolved)

  try {
    const audio = await synthesizeSpeech(spokenText, {
      voice: voiceProfile.voice,
      instructions: voiceProfile.instructions,
    })
    await provider.sendAudio({
      providerBotId: session.provider_bot_id,
      audio: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer,
      mimeType: 'audio/mp3',
    })
  } catch (err) {
    console.error('[meeting pipeline] failed to synthesize/send speech:', err)
  }

  try {
    await provider.sendChatMessage({ providerBotId: session.provider_bot_id, message: spokenText })
  } catch (err) {
    console.error('[meeting pipeline] failed to deliver intervention:', err)
  }
}
