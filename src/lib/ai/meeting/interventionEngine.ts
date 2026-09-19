/**
 * The intervention engine: decides WHETHER Urushi should speak, separately from
 * WHAT it says (spec §22).
 *
 * Three stages, cheapest first — this ordering is what keeps latency acceptable in
 * a live call (spec §23):
 *
 *   Stage 0  preGate()      pure, ~0ms. Trivial utterances, cooldown, budget and
 *                           BACK_OFF are rejected here without any model call. In a
 *                           normal meeting this eliminates the large majority of
 *                           utterances, so most transcript chunks cost nothing.
 *   Stage A  decideIntervention()  one small, low-token model call that answers
 *                           only "should you speak, why, how urgently, how to
 *                           enter" — no wording. Cheap and fast.
 *   Stage B  generateInterventionSpeech()  a second call, run ONLY when Stage A
 *                           says yes, that writes the actual line with the full
 *                           persona prompt.
 *
 * The separation matters: when a single call is asked to both judge and speak,
 * models overwhelmingly choose to speak, because producing text is the path of
 * least resistance. Splitting the decision out is the main defence against the
 * classic over-talkative AI facilitator.
 */

import { getEnv } from '@/lib/env'
import {
  getInterventionTuning,
  isUrgentReason,
  thresholdForReason,
  effectiveLanguage,
  INTERVENTION_REASONS,
  type InterventionReason,
  type InterventionStyle,
  type InterventionUrgency,
  type MeetingAgentSettings,
  type MeetingPersonality,
} from '@/lib/meeting/agentSettings'
import {
  dominanceSignal,
  interventionsInLast10Min,
  secondsSinceUrushiSpoke,
  detectPersonalAttack,
  type RuntimeState,
} from '@/lib/meeting/runtimeState'
import { isTrivialUtterance } from './interventionGuardrails'
import { overrideThresholdMultiplier, type OverrideState } from './overrideCommands'
import { buildMeetingSystemPrompt } from './personaPrompt'
import { detectRoomLanguage } from './languageDetection'

export interface InterventionDecision {
  shouldIntervene: boolean
  reason?: InterventionReason
  urgency: InterventionUrgency
  style: InterventionStyle
  confidence: number
  intendedOutcome?: string
  /** Why the engine declined — telemetry only, never shown to participants. */
  suppressedBy?: 'trivial' | 'cooldown' | 'budget' | 'threshold' | 'back_off' | 'model'
}

export const NO_INTERVENTION: InterventionDecision = {
  shouldIntervene: false,
  urgency: 'LOW',
  style: 'NATURAL',
  confidence: 0,
}

export interface EngineContext {
  settings: MeetingAgentSettings
  state: RuntimeState
  override: OverrideState
  topic: string
  contextSummary?: string
  participantNames: string[]
  latestUtterance: { speaker: string; text: string }
  recentTranscript: Array<{ speaker: string; text: string }>
  /** Private pre-meeting perspectives — never to be quoted aloud. */
  perspectives?: Array<{ participantName: string; perspective: string }>
  now?: number
}

// ─── Stage 0: deterministic pre-gate ─────────────────────────────────────────

export interface PreGateResult {
  proceed: boolean
  suppressedBy?: InterventionDecision['suppressedBy']
  /** Set when a deterministic signal alone justifies bypassing cooldown/budget. */
  forcedReason?: InterventionReason
}

/**
 * Pure, no model call. Rejects the utterances that obviously do not warrant a
 * decision, and force-admits the ones that obviously do.
 */
export function preGate(ctx: EngineContext): PreGateResult {
  const now = ctx.now ?? Date.now()
  const { settings, state, override, latestUtterance } = ctx

  // Safety and fairness are never rationed — these bypass cooldown, budget and
  // even an active BACK_OFF (spec §14, §28).
  if (detectPersonalAttack(latestUtterance.text)) {
    return { proceed: true, forcedReason: 'PERSONAL_ATTACK' }
  }
  if (state.escalationLevel >= 0.75) {
    return { proceed: true, forcedReason: 'ESCALATION' }
  }

  // An explicit invitation is honoured immediately.
  if (override.mode === 'STEP_IN') return { proceed: true }

  if (isTrivialUtterance(latestUtterance.text)) {
    return { proceed: false, suppressedBy: 'trivial' }
  }

  const tuning = getInterventionTuning(settings)

  if (secondsSinceUrushiSpoke(state, now) < tuning.cooldownSeconds) {
    return { proceed: false, suppressedBy: 'cooldown' }
  }

  if (interventionsInLast10Min(state, now) >= tuning.budgetPer10Min) {
    return { proceed: false, suppressedBy: 'budget' }
  }

  return { proceed: true }
}

// ─── Stage A: should Urushi speak? ───────────────────────────────────────────

/**
 * One line each, not the full persona modules: Stage A only judges whether the
 * floor is worth taking, and the personality shifts which reasons it leans
 * toward. The wording itself comes from the persona prompt in Stage B.
 */
const PERSONALITY_SUMMARY: Record<MeetingPersonality, string> = {
  diplomat: 'Diplomat — calm and constructive, surfaces misunderstandings and drives toward a way forward',
  straight_shooter: 'Straight Shooter — blunt, calls out avoidance and contradiction',
  deal_maker: 'Deal Maker — practical, pushes trade-offs toward a concrete, specific agreement',
}

function buildDecisionPrompt(ctx: EngineContext): { system: string; user: string } {
  const { settings } = ctx

  const system = `You are the intervention controller for Urushi, an AI participant in a live ${ctx.participantNames.length}-person video meeting (${ctx.participantNames.join(', ')}).

# Your only job
Decide whether speaking RIGHT NOW would materially improve this conversation. You do NOT write what Urushi says — a separate step does that. Judge only whether the floor is worth taking.

This is the hardest judgement in the product. Producing an intervention is easy; knowing when silence is better is the valuable part. Participants talking productively to each other is the desired state, not a gap to fill.

# Urushi's configured role
Personality: ${PERSONALITY_SUMMARY[settings.personality]}
Participation level: ${settings.interventionLevel}

# Strong reasons to speak
- The conversation is repeating itself (CIRCULAR_DISCUSSION)
- A direct question was asked and dodged (UNANSWERED_QUESTION)
- Someone contradicts a position they took earlier (CONTRADICTION)
- One participant is dominating (DOMINATING_PARTICIPANT)
- Someone is repeatedly cut off (PARTICIPANT_INTERRUPTED)
- An emotional injury is clearly driving a supposedly practical dispute (EMOTIONAL_ISSUE)
- The conversation has drifted from the decision (AGENDA_DRIFT)
- A factual disagreement is being confused with a values disagreement (FACT_VS_INTERPRETATION)
- The participants already agree but haven't noticed (HIDDEN_AGREEMENT)
- Enough has been said to decide (DECISION_READY)
- Things are escalating (ESCALATION) or have turned personal (PERSONAL_ATTACK)
- A compounding misunderstanding needs clearing up (CLARIFICATION_NEEDED)
- A resolved discussion has no concrete next step (NEXT_STEP_NEEDED)
- Someone is hedging, staying abstract, or answering a different question than the one asked instead of getting to the point (VAGUENESS)
- Someone's claim isn't backed by anything actually said, their story doesn't add up, or the framing looks designed to manipulate rather than inform (UNSUPPORTED_CLAIM)

# Weak reasons — these are NOT sufficient. Answer false.
- You have a nicer way to phrase what someone said
- You could add a perspective, but the conversation doesn't need it
- It feels like time for a summary
- Someone made a small factual slip that doesn't matter
- There was a brief silence
- You want to show you are engaged and listening

Do not summarise periodically out of habit. That is the single most common failure mode for AI facilitators.

# Entry style
NATURAL — the speaker finished; step in cleanly. Use this for most interventions.
POLITE_INTERRUPT — cut in mid-flow because the conversation is looping, someone is dominating, a question is being ignored, or a misunderstanding is compounding.
HARD_INTERRUPT — rare. Only for people talking over each other, shouting, personal attacks, or serious escalation.

# Confidence
0.0-1.0, how sure you are that speaking now beats staying silent. Be honest and calibrated; a caller applies thresholds to this number. Low confidence is a useful answer.

# Output — JSON only, no preamble, no markdown fences
{
  "shouldIntervene": boolean,
  "reason": "<one of the reason codes above, only if shouldIntervene>",
  "urgency": "LOW" | "MEDIUM" | "HIGH",
  "style": "NATURAL" | "POLITE_INTERRUPT" | "HARD_INTERRUPT",
  "confidence": number,
  "intendedOutcome": "<short phrase: what speaking should achieve>"
}`

  const dominance = dominanceSignal(ctx.state)
  const signals = [
    `Repetition score: ${ctx.state.circularityScore.toFixed(2)} (0 = fresh ground, 1 = going in circles)`,
    `Escalation level: ${ctx.state.escalationLevel.toFixed(2)} (0 = calm, 1 = heated)`,
    dominance ? `Floor share: ${dominance.speaker} has ${Math.round(dominance.share * 100)}% of words spoken` : null,
    ctx.state.unansweredQuestions.length > 0
      ? `Open questions: ${ctx.state.unansweredQuestions.map((q) => `${q.askedBy} asked "${q.text}"`).join(' | ')}`
      : null,
    Object.entries(ctx.state.interruptionCounts).length > 0
      ? `Cut-offs: ${Object.entries(ctx.state.interruptionCounts).map(([s, n]) => `${s} x${n}`).join(', ')}`
      : null,
    ctx.state.recentInterventions.length > 0
      ? `Urushi's recent interventions: ${ctx.state.recentInterventions.map((i) => i.reason).join(', ')} — do not repeat the same move`
      : 'Urushi has not spoken yet',
  ].filter(Boolean).join('\n')

  const perspectives = ctx.perspectives?.length
    ? `\nPrivate pre-meeting perspectives (hypotheses only — NEVER to be quoted or attributed aloud):\n${ctx.perspectives.map((p) => `${p.participantName}: ${p.perspective}`).join('\n')}\n`
    : ''

  const user = `Topic: ${ctx.topic}
${ctx.contextSummary ? `Background: ${ctx.contextSummary}\n` : ''}${perspectives}
Conversation so far (oldest first):
${ctx.recentTranscript.map((t) => `${t.speaker}: ${t.text}`).join('\n') || '(nothing yet)'}

Just said:
${ctx.latestUtterance.speaker}: ${ctx.latestUtterance.text}

Signals:
${signals}

Should Urushi speak right now?`

  return { system, user }
}

interface RawDecision {
  shouldIntervene?: unknown
  reason?: unknown
  urgency?: unknown
  style?: unknown
  confidence?: unknown
  intendedOutcome?: unknown
}

function coerceDecision(raw: RawDecision): InterventionDecision {
  const reason = typeof raw.reason === 'string' && (INTERVENTION_REASONS as readonly string[]).includes(raw.reason)
    ? (raw.reason as InterventionReason)
    : undefined
  const style: InterventionStyle =
    raw.style === 'POLITE_INTERRUPT' || raw.style === 'HARD_INTERRUPT' ? raw.style : 'NATURAL'
  const urgency: InterventionUrgency =
    raw.urgency === 'HIGH' || raw.urgency === 'MEDIUM' ? raw.urgency : 'LOW'
  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0

  return {
    shouldIntervene: raw.shouldIntervene === true && reason !== undefined,
    ...(reason ? { reason } : {}),
    urgency,
    style,
    confidence,
    ...(typeof raw.intendedOutcome === 'string' && raw.intendedOutcome.trim()
      ? { intendedOutcome: raw.intendedOutcome.trim() }
      : {}),
  }
}

/**
 * Applies the configured thresholds to a model decision. Kept pure and separate
 * from the model call so threshold behaviour is directly unit-testable.
 */
export function applyThresholds(
  decision: InterventionDecision,
  ctx: EngineContext,
  forcedReason?: InterventionReason
): InterventionDecision {
  const now = ctx.now ?? Date.now()

  if (forcedReason) {
    return {
      ...decision,
      shouldIntervene: true,
      reason: forcedReason,
      urgency: 'HIGH',
      style: 'HARD_INTERRUPT',
      confidence: Math.max(decision.confidence, 0.9),
    }
  }

  if (!decision.shouldIntervene || !decision.reason) {
    return { ...decision, shouldIntervene: false, suppressedBy: 'model' }
  }

  // Urgent reasons bypass thresholds entirely.
  if (isUrgentReason(decision.reason)) return decision

  const base = thresholdForReason(ctx.settings, decision.reason)
  const threshold = base * overrideThresholdMultiplier(ctx.override, now)

  if (decision.confidence < threshold) {
    return {
      ...decision,
      shouldIntervene: false,
      suppressedBy: ctx.override.mode === 'BACK_OFF' ? 'back_off' : 'threshold',
    }
  }

  return decision
}

/**
 * Stage A. Returns a decision without any spoken wording.
 * Throws only on transport failure — callers treat that as "stay silent".
 */
export async function decideIntervention(ctx: EngineContext): Promise<InterventionDecision> {
  const gate = preGate(ctx)
  if (!gate.proceed) {
    return { ...NO_INTERVENTION, ...(gate.suppressedBy ? { suppressedBy: gate.suppressedBy } : {}) }
  }

  // A forced reason is a deterministic signal strong enough that we skip the
  // decision call entirely and go straight to speech — lower latency exactly when
  // the room most needs an immediate response.
  if (gate.forcedReason) {
    return applyThresholds(NO_INTERVENTION, ctx, gate.forcedReason)
  }

  const { OPENAI_API_KEY, OPENAI_MODEL, DEMO_MODE } = getEnv()
  if (DEMO_MODE) return { ...NO_INTERVENTION, suppressedBy: 'model' }
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.')

  const { system, user } = buildDecisionPrompt(ctx)

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      // Decision only — no prose to generate, so this stays small and fast.
      max_tokens: 160,
      temperature: 0.1,
    }),
  })

  if (!res.ok) {
    throw new Error(`Intervention decision failed (${res.status}): ${await res.text()}`)
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  const rawContent = data.choices?.[0]?.message?.content
  if (!rawContent) throw new Error('Empty decision response.')

  let parsed: RawDecision
  try {
    parsed = JSON.parse(rawContent) as RawDecision
  } catch {
    throw new Error('Intervention decision returned invalid JSON.')
  }

  return applyThresholds(coerceDecision(parsed), ctx)
}

// ─── Stage B: what does Urushi say? ──────────────────────────────────────────

/**
 * Stage B. Only called when Stage A approved an intervention. Uses the full
 * persona prompt so wording carries personality, region, language and entry style.
 */
export async function generateInterventionSpeech(
  ctx: EngineContext,
  decision: InterventionDecision
): Promise<string> {
  if (!decision.reason) throw new Error('Cannot generate speech without a decision reason.')

  const { OPENAI_API_KEY, OPENAI_MODEL } = getEnv()
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.')

  // Only meaningful in 'auto' mode — fixed hindi/hinglish/english settings (or a
  // non-Indian region, which forces English via effectiveLanguage) always use that
  // language regardless of what the room is actually speaking.
  const detectedLanguage = effectiveLanguage(ctx.settings) === 'auto'
    ? detectRoomLanguage(ctx.latestUtterance.text, ctx.recentTranscript.map((t) => t.text))
    : undefined

  const system = buildMeetingSystemPrompt({
    settings: ctx.settings,
    meetingContext: {
      topic: ctx.topic,
      participantNames: ctx.participantNames,
      ...(ctx.contextSummary ? { contextSummary: ctx.contextSummary } : {}),
    },
    intervention: {
      reason: decision.reason,
      style: decision.style,
      ...(decision.intendedOutcome ? { intendedOutcome: decision.intendedOutcome } : {}),
      ...(detectedLanguage ? { detectedLanguage } : {}),
    },
  })

  const perspectives = ctx.perspectives?.length
    ? `\nPrivate pre-meeting perspectives (hypotheses — never quote or attribute these aloud; reframe neutrally):\n${ctx.perspectives.map((p) => `${p.participantName}: ${p.perspective}`).join('\n')}\n`
    : ''

  const user = `Conversation so far (oldest first):
${ctx.recentTranscript.map((t) => `${t.speaker}: ${t.text}`).join('\n') || '(nothing yet)'}

Just said:
${ctx.latestUtterance.speaker}: ${ctx.latestUtterance.text}
${perspectives}
Say your piece now.`

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      // Deliberately small — Urushi should be speaking one or two sentences, not
      // a paragraph. This is a hard backstop, not the primary length control:
      // the prompt asks for brevity, but models don't reliably self-limit, so
      // the cap plus the sentence-trim below enforce it regardless.
      max_tokens: 90,
      temperature: 0.6,
    }),
  })

  if (!res.ok) {
    throw new Error(`Intervention speech failed (${res.status}): ${await res.text()}`)
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  const text = data.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('Empty speech response.')

  // Models occasionally wrap spoken lines in quotes or prefix a speaker label
  // despite the instruction; strip both so nothing odd reaches the TTS layer.
  const cleaned = text.replace(/^["'`]+|["'`]+$/g, '').replace(/^Urushi:\s*/i, '').trim()
  return capToSentences(cleaned, 2)
}

/**
 * Hard backstop for brevity (spec: "speak less"). Keeps at most `max` sentences —
 * models occasionally ignore the one-or-two-sentence instruction under
 * max_tokens pressure and produce a truncated run-on instead; this trims to
 * whole sentences rather than leaving a cut-off fragment.
 */
function capToSentences(text: string, max: number): string {
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)
  if (!sentences || sentences.length <= max) return text
  return sentences.slice(0, max).join('').trim()
}
