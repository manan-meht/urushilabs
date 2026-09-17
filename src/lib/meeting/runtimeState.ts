/**
 * Lightweight structured meeting state (spec §9).
 *
 * Rather than re-deriving everything from the full transcript on every incoming
 * utterance — which gets slower and more expensive as the meeting runs — this is
 * updated incrementally, one utterance at a time, and persisted as JSONB on
 * meeting_sessions.runtime_state.
 *
 * Everything here is pure: `updateRuntimeState` takes the previous state plus one
 * utterance and returns the next state. No I/O, fully unit-testable, and cheap
 * enough to run on every transcript chunk without adding latency (spec §23).
 */

import type { InterventionReason, InterventionStyle } from './agentSettings'

export interface RecentIntervention {
  reason: InterventionReason
  style: InterventionStyle
  at: number
}

export interface RuntimeState {
  /** Rough proxy for speaking time: words spoken per participant. */
  wordsBySpeaker: Record<string, number>
  /** How often each participant appears to cut someone else off. */
  interruptionCounts: Record<string, number>
  /** Direct questions asked but not yet answered. */
  unansweredQuestions: Array<{ askedBy: string; text: string; at: number }>
  /** Rolling window of recent utterances, used for circularity detection. */
  recentUtterances: Array<{ speaker: string; text: string; at: number }>
  /** 0-1. How much the conversation is repeating itself. */
  circularityScore: number
  /** 0-1. How heated the conversation is. */
  escalationLevel: number
  urushiLastSpokeAt?: number
  recentInterventions: RecentIntervention[]
  /** Epoch ms of the first observed utterance — used for budget-per-10-min. */
  startedAt?: number
  lastUtteranceAt?: number
}

export const EMPTY_RUNTIME_STATE: RuntimeState = {
  wordsBySpeaker: {},
  interruptionCounts: {},
  unansweredQuestions: [],
  recentUtterances: [],
  circularityScore: 0,
  escalationLevel: 0,
  recentInterventions: [],
}

const RECENT_UTTERANCE_WINDOW = 14
const RECENT_INTERVENTION_WINDOW = 8
const MAX_UNANSWERED_QUESTIONS = 6
/** An utterance starting within this many ms of the previous one reads as a cut-off. */
const INTERRUPTION_GAP_MS = 1200

export function parseRuntimeState(raw: unknown): RuntimeState {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_RUNTIME_STATE }
  const r = raw as Partial<RuntimeState>
  return {
    wordsBySpeaker: r.wordsBySpeaker ?? {},
    interruptionCounts: r.interruptionCounts ?? {},
    unansweredQuestions: r.unansweredQuestions ?? [],
    recentUtterances: r.recentUtterances ?? [],
    circularityScore: typeof r.circularityScore === 'number' ? r.circularityScore : 0,
    escalationLevel: typeof r.escalationLevel === 'number' ? r.escalationLevel : 0,
    ...(r.urushiLastSpokeAt !== undefined ? { urushiLastSpokeAt: r.urushiLastSpokeAt } : {}),
    recentInterventions: r.recentInterventions ?? [],
    ...(r.startedAt !== undefined ? { startedAt: r.startedAt } : {}),
    ...(r.lastUtteranceAt !== undefined ? { lastUtteranceAt: r.lastUtteranceAt } : {}),
  }
}

// ─── Signal detection ─────────────────────────────────────────────────────────

const QUESTION_PATTERN = /\?\s*$/
/** Questions that genuinely demand an answer, vs. rhetorical/filler ones. */
const DIRECT_QUESTION_PATTERN = /\b(did|do|does|are|is|was|were|will|would|can|could|should|have|has|why|what|when|who|how much|how many)\b/i

// Ordinary swearing directed at a situation, decision or argument ("this is
// bullshit", "what the fuck") is normal in a heated real conversation and must
// NOT read as escalation or a personal attack on its own — only language
// targeted AT a person does. Confusing the two was making Urushi over-trigger
// HARD_INTERRUPT on ordinary frustration, which then drained the intervention
// budget and left it unable to speak for the rest of the window.
const HEAT_PATTERNS: RegExp[] = [
  /\byou (always|never)\b/i,
  /\b(shut up|stop talking|let me finish|don'?t interrupt)\b/i,
  /\b(sick of|fed up|had enough)\b/i,
]
// Requires second-person targeting ("you're an idiot") — a bare insult word on
// its own ("that's pathetic", describing a plan or a deadline) is not an attack.
const PERSONAL_ATTACK_PATTERNS: RegExp[] = [
  /\byou'?re (such an? )?(idiot|stupid|pathetic|useless|worthless|moron|joke|liar|joke of a)\b/i,
  /\byou'?re (an? )?(fucking |god damn |goddamn )?(idiot|stupid|pathetic|useless|worthless|moron)\b/i,
  /\bshut up\b.{0,20}\byou\b|\byou\b.{0,20}\bshut up\b/i,
]

export function detectPersonalAttack(text: string): boolean {
  return PERSONAL_ATTACK_PATTERNS.some((p) => p.test(text))
}

function heatOf(text: string): number {
  let heat = 0
  for (const p of HEAT_PATTERNS) if (p.test(text)) heat += 0.15
  if (detectPersonalAttack(text)) heat += 0.45
  if (/[A-Z]{4,}/.test(text)) heat += 0.08
  return Math.min(1, heat)
}

function isDirectQuestion(text: string): boolean {
  return QUESTION_PATTERN.test(text.trim()) && DIRECT_QUESTION_PATTERN.test(text)
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'that', 'this', 'these', 'those',
  'i', 'you', 'we', 'they', 'he', 'she', 'it', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'as', 'so', 'do', 'does',
  'did', 'not', 'no', 'yes', 'just', 'about', 'what', 'when', 'how', 'why', 'me', 'my',
  'your', 'our', 'their', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should',
])

function contentWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  )
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / Math.min(a.size, b.size)
}

/**
 * Circularity = how much the same speaker keeps making the same point. Compares the
 * new utterance against that speaker's earlier turns in the window; repeated
 * high-overlap turns push the score up, genuinely new content pulls it down.
 */
function computeCircularity(
  previous: RuntimeState,
  speaker: string,
  text: string
): number {
  const words = contentWords(text)
  if (words.size < 3) return previous.circularityScore * 0.97

  const sameSpeakerTurns = previous.recentUtterances.filter((u) => u.speaker === speaker)
  if (sameSpeakerTurns.length === 0) return previous.circularityScore * 0.9

  const maxOverlap = Math.max(...sameSpeakerTurns.map((u) => overlap(words, contentWords(u.text))))
  // Decay toward the observed repetition rather than jumping, so one similar
  // sentence doesn't read as a circular argument.
  const target = maxOverlap > 0.5 ? Math.min(1, previous.circularityScore + 0.3) : previous.circularityScore * 0.75
  return Math.max(0, Math.min(1, target))
}

export interface UtteranceInput {
  speaker: string
  text: string
  /** Epoch ms. Defaults to now. */
  at?: number
  /** True when this utterance is Urushi's own speech. */
  isUrushi?: boolean
}

export function updateRuntimeState(previous: RuntimeState, utterance: UtteranceInput): RuntimeState {
  const at = utterance.at ?? Date.now()
  const { speaker, text } = utterance

  if (utterance.isUrushi) {
    return { ...previous, urushiLastSpokeAt: at, lastUtteranceAt: at, startedAt: previous.startedAt ?? at }
  }

  const wordCount = text.trim().split(/\s+/).filter(Boolean).length

  // Interruption heuristic: a different speaker starting almost immediately after
  // the previous utterance reads as cutting in.
  const interruptionCounts = { ...previous.interruptionCounts }
  const lastUtterance = previous.recentUtterances[previous.recentUtterances.length - 1]
  if (
    lastUtterance &&
    lastUtterance.speaker !== speaker &&
    previous.lastUtteranceAt !== undefined &&
    at - previous.lastUtteranceAt < INTERRUPTION_GAP_MS
  ) {
    interruptionCounts[speaker] = (interruptionCounts[speaker] ?? 0) + 1
  }

  // A question is considered answered once the *other* party has said something
  // substantive after it.
  const unanswered = previous.unansweredQuestions
    .filter((q) => !(q.askedBy !== speaker && wordCount >= 4))
    .slice(-MAX_UNANSWERED_QUESTIONS)
  if (isDirectQuestion(text)) {
    unanswered.push({ askedBy: speaker, text: text.trim(), at })
  }

  const escalationDecay = previous.escalationLevel * 0.93
  const escalationLevel = Math.max(0, Math.min(1, escalationDecay + heatOf(text)))

  return {
    wordsBySpeaker: { ...previous.wordsBySpeaker, [speaker]: (previous.wordsBySpeaker[speaker] ?? 0) + wordCount },
    interruptionCounts,
    unansweredQuestions: unanswered.slice(-MAX_UNANSWERED_QUESTIONS),
    recentUtterances: [...previous.recentUtterances, { speaker, text, at }].slice(-RECENT_UTTERANCE_WINDOW),
    circularityScore: computeCircularity(previous, speaker, text),
    escalationLevel,
    ...(previous.urushiLastSpokeAt !== undefined ? { urushiLastSpokeAt: previous.urushiLastSpokeAt } : {}),
    recentInterventions: previous.recentInterventions,
    startedAt: previous.startedAt ?? at,
    lastUtteranceAt: at,
  }
}

export function recordIntervention(
  state: RuntimeState,
  intervention: RecentIntervention
): RuntimeState {
  return {
    ...state,
    urushiLastSpokeAt: intervention.at,
    recentInterventions: [...state.recentInterventions, intervention].slice(-RECENT_INTERVENTION_WINDOW),
  }
}

// ─── Derived signals ──────────────────────────────────────────────────────────

/**
 * Share of words spoken by the most talkative participant, plus who that is.
 * Returns null until there is enough material to judge.
 */
export function dominanceSignal(state: RuntimeState): { speaker: string; share: number } | null {
  const entries = Object.entries(state.wordsBySpeaker)
  if (entries.length < 2) return null
  const total = entries.reduce((sum, [, n]) => sum + n, 0)
  if (total < 120) return null
  const [speaker, words] = entries.reduce((max, e) => (e[1] > max[1] ? e : max))
  return { speaker, share: words / total }
}

/** The participant who has spoken least — the one to hand the floor back to. */
export function quietestParticipant(state: RuntimeState, allParticipants: string[]): string | null {
  if (allParticipants.length < 2) return null
  let quietest: string | null = null
  let fewest = Infinity
  for (const name of allParticipants) {
    const words = state.wordsBySpeaker[name] ?? 0
    if (words < fewest) { fewest = words; quietest = name }
  }
  return quietest
}

/** Interventions Urushi has made in the last 10 minutes — the budget window. */
export function interventionsInLast10Min(state: RuntimeState, now: number = Date.now()): number {
  const cutoff = now - 10 * 60 * 1000
  return state.recentInterventions.filter((i) => i.at >= cutoff).length
}

export function secondsSinceUrushiSpoke(state: RuntimeState, now: number = Date.now()): number {
  if (state.urushiLastSpokeAt === undefined) return Number.POSITIVE_INFINITY
  return (now - state.urushiLastSpokeAt) / 1000
}
