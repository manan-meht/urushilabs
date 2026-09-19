/**
 * Meeting-agent configuration: how Urushi behaves, sounds and intervenes in a
 * live Google Meet / Zoom conversation.
 *
 * Two axes are deliberately kept independent (spec §7): PERSONALITY is *how*
 * Urushi speaks, INTERVENTION LEVEL is *how often*. "Diplomat personality +
 * Chair-the-meeting level" is a valid combination — the tuning table below
 * composes both rather than branching on a single enum. Note the level named
 * 'chair' is NOT a personality; the two enums share a word, nothing else.
 *
 * Everything here is pure data + pure functions so the intervention engine and
 * the prompt builder can be unit-tested without any I/O.
 */

import { MEDIATOR_PERSONALITIES, type MediatorPersonality } from '@/lib/conversation/settings'

/**
 * Meetings use the product-wide personality set rather than their own, so the
 * mediator a room configured is the same one it gets in its summary and report.
 * Alias only — kept so meeting-side call sites keep reading in meeting terms.
 */
export type MeetingPersonality = MediatorPersonality
export type VoiceGender = 'female' | 'male'
export type VoiceRegion = 'american' | 'singaporean' | 'indian'
export type AgentLanguage = 'english' | 'hindi' | 'hinglish' | 'auto'
export type InterventionLevel = 'observer' | 'facilitator' | 'chair'
export type LanguageStyle = 'clean' | 'direct' | 'unfiltered'

export interface MeetingAgentSettings {
  personality: MeetingPersonality
  voiceGender: VoiceGender
  region: VoiceRegion
  language: AgentLanguage
  interventionLevel: InterventionLevel
  languageStyle: LanguageStyle
}

/**
 * Defaults (spec §19). Region defaults to American because that is what the
 * existing TTS configuration already represents — deliberately NOT inferred from
 * the user's name, email or locale.
 */
export const DEFAULT_MEETING_AGENT_SETTINGS: MeetingAgentSettings = {
  personality: 'diplomat',
  voiceGender: 'female',
  region: 'american',
  language: 'auto',
  interventionLevel: 'facilitator',
  languageStyle: 'direct',
}

const VOICE_GENDERS: readonly VoiceGender[] = ['female', 'male']
const REGIONS: readonly VoiceRegion[] = ['american', 'singaporean', 'indian']
const LANGUAGES: readonly AgentLanguage[] = ['english', 'hindi', 'hinglish', 'auto']
const INTERVENTION_LEVELS: readonly InterventionLevel[] = ['observer', 'facilitator', 'chair']
const LANGUAGE_STYLES: readonly LanguageStyle[] = ['clean', 'direct', 'unfiltered']

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/**
 * Normalizes a persisted (possibly partial, possibly pre-migration NULL) settings
 * row into a complete settings object. Sessions created before this feature have
 * NULL columns and must keep working — they resolve to the defaults (spec §20).
 */
export function normalizeAgentSettings(raw: Partial<Record<keyof MeetingAgentSettings, unknown>> | null | undefined): MeetingAgentSettings {
  const r = raw ?? {}
  const personality = pick(MEDIATOR_PERSONALITIES, r.personality, DEFAULT_MEETING_AGENT_SETTINGS.personality)
  return {
    personality,
    voiceGender: pick(VOICE_GENDERS, r.voiceGender, DEFAULT_MEETING_AGENT_SETTINGS.voiceGender),
    region: pick(REGIONS, r.region, DEFAULT_MEETING_AGENT_SETTINGS.region),
    language: pick(LANGUAGES, r.language, DEFAULT_MEETING_AGENT_SETTINGS.language),
    interventionLevel: pick(INTERVENTION_LEVELS, r.interventionLevel, DEFAULT_MEETING_AGENT_SETTINGS.interventionLevel),
    // Only the Straight Shooter has a profanity control at all — the UI hides it
    // for the others (spec §6), and it is forced here too so a hand-crafted API
    // call can't route around a control the user never saw.
    languageStyle: personality !== 'straight_shooter'
      ? 'clean'
      : pick(LANGUAGE_STYLES, r.languageStyle, DEFAULT_MEETING_AGENT_SETTINGS.languageStyle),
  }
}

/**
 * Overlays the conversation's agreed settings onto a meeting's stored agent row.
 *
 * Personality, language and profanity are agreed ONCE for the whole conversation
 * and live on `cases`; meeting_sessions keeps only the axes that are genuinely
 * meeting-specific (voice gender, accent region, how often to interrupt).
 *
 * This exists because the two were briefly configurable in both places, which
 * meant a meeting could run as the Straight Shooter live and be written up as
 * the Diplomat — the exact competing-configuration problem the shared settings
 * model was introduced to remove. The shared value always wins; the agent row is
 * only consulted for what it alone knows.
 */
export function withConversationSettings(
  agent: MeetingAgentSettings,
  conversation: {
    personality: MeetingPersonality
    language: 'english' | 'hindi' | 'hinglish'
    allowProfanity: boolean
  }
): MeetingAgentSettings {
  return normalizeAgentSettings({
    ...agent,
    personality: conversation.personality,
    language: conversation.language,
    // The 3-tier meeting style collapses to the shared boolean. Off is off; on
    // resolves to 'unfiltered', which is the tier that measurably produces the
    // language a user turning this on is asking for — 'direct' kept reaching for
    // a polite synonym in exactly the moment the setting exists for.
    languageStyle: conversation.allowProfanity ? 'unfiltered' : 'clean',
  })
}

/** Language selection only applies to the Indian region (spec §5). */
export function effectiveLanguage(settings: MeetingAgentSettings): AgentLanguage {
  return settings.region === 'indian' ? settings.language : 'english'
}

/** Maps DB snake_case columns to the settings object. */
export function agentSettingsFromRow(row: {
  agent_personality?: unknown
  agent_voice_gender?: unknown
  agent_region?: unknown
  agent_language?: unknown
  agent_intervention_level?: unknown
  agent_language_style?: unknown
} | null | undefined): MeetingAgentSettings {
  return normalizeAgentSettings({
    personality: row?.agent_personality,
    voiceGender: row?.agent_voice_gender,
    region: row?.agent_region,
    language: row?.agent_language,
    interventionLevel: row?.agent_intervention_level,
    languageStyle: row?.agent_language_style,
  })
}

/** Maps the settings object to DB snake_case columns. */
export function agentSettingsToRow(settings: MeetingAgentSettings): Record<string, string> {
  return {
    agent_personality: settings.personality,
    agent_voice_gender: settings.voiceGender,
    agent_region: settings.region,
    agent_language: settings.language,
    agent_intervention_level: settings.interventionLevel,
    agent_language_style: settings.languageStyle,
  }
}

// ─── Intervention tuning ──────────────────────────────────────────────────────

/**
 * Why Urushi wants to speak. Stored on each intervention so we can later analyse
 * whether Urushi interrupts too often, and for what (spec §10, §25).
 */
export type InterventionReason =
  | 'CIRCULAR_DISCUSSION'
  | 'UNANSWERED_QUESTION'
  | 'CONTRADICTION'
  | 'DOMINATING_PARTICIPANT'
  | 'PARTICIPANT_INTERRUPTED'
  | 'EMOTIONAL_ISSUE'
  | 'AGENDA_DRIFT'
  | 'FACT_VS_INTERPRETATION'
  | 'HIDDEN_AGREEMENT'
  | 'DECISION_READY'
  | 'ESCALATION'
  | 'PERSONAL_ATTACK'
  | 'CLARIFICATION_NEEDED'
  | 'NEXT_STEP_NEEDED'
  | 'VAGUENESS'
  | 'UNSUPPORTED_CLAIM'

export const INTERVENTION_REASONS: readonly InterventionReason[] = [
  'CIRCULAR_DISCUSSION', 'UNANSWERED_QUESTION', 'CONTRADICTION', 'DOMINATING_PARTICIPANT',
  'PARTICIPANT_INTERRUPTED', 'EMOTIONAL_ISSUE', 'AGENDA_DRIFT', 'FACT_VS_INTERPRETATION',
  'HIDDEN_AGREEMENT', 'DECISION_READY', 'ESCALATION', 'PERSONAL_ATTACK',
  'CLARIFICATION_NEEDED', 'NEXT_STEP_NEEDED', 'VAGUENESS', 'UNSUPPORTED_CLAIM',
]

/** How Urushi enters the conversation (spec §8). */
export type InterventionStyle = 'NATURAL' | 'POLITE_INTERRUPT' | 'HARD_INTERRUPT'
export type InterventionUrgency = 'LOW' | 'MEDIUM' | 'HIGH'

export interface InterventionTuning {
  /** Minimum confidence (0-1) the engine must have before spending an interruption. */
  confidenceThreshold: number
  /** Seconds Urushi must stay quiet after speaking, before a non-urgent intervention. */
  cooldownSeconds: number
  /** Max interventions per 10 minutes of meeting — the "intervention budget" (spec §11). */
  budgetPer10Min: number
}

const LEVEL_TUNING: Record<InterventionLevel, InterventionTuning> = {
  observer: { confidenceThreshold: 0.8, cooldownSeconds: 150, budgetPer10Min: 2 },
  facilitator: { confidenceThreshold: 0.62, cooldownSeconds: 65, budgetPer10Min: 5 },
  chair: { confidenceThreshold: 0.48, cooldownSeconds: 35, budgetPer10Min: 9 },
}

/**
 * Reasons each personality is primed to act on earlier (spec §12). These shave the
 * confidence threshold for that reason only — they never bypass the budget or the
 * hard-escalation path.
 */
const PERSONALITY_PRIORITY_REASONS: Record<MeetingPersonality, ReadonlySet<InterventionReason>> = {
  diplomat: new Set<InterventionReason>([
    'AGENDA_DRIFT', 'DOMINATING_PARTICIPANT', 'DECISION_READY', 'NEXT_STEP_NEEDED', 'UNANSWERED_QUESTION',
    'VAGUENESS',
  ]),
  straight_shooter: new Set<InterventionReason>([
    'CONTRADICTION', 'CIRCULAR_DISCUSSION', 'UNANSWERED_QUESTION', 'FACT_VS_INTERPRETATION',
    'VAGUENESS', 'UNSUPPORTED_CLAIM',
  ]),
  // Everything that stands between the room and a concrete, specific agreement:
  // a decision that is ripe, a resolution with no owner or date, agreement
  // nobody has noticed, and wording too vague to hold anyone to.
  deal_maker: new Set<InterventionReason>([
    'DECISION_READY', 'NEXT_STEP_NEEDED', 'HIDDEN_AGREEMENT', 'VAGUENESS', 'UNANSWERED_QUESTION',
  ]),
}

const PRIORITY_THRESHOLD_DISCOUNT = 0.12

/**
 * Reasons that always justify speaking regardless of cooldown/budget. Safety and
 * basic conversational fairness are not rationed.
 */
export const URGENT_REASONS: ReadonlySet<InterventionReason> = new Set<InterventionReason>([
  'ESCALATION', 'PERSONAL_ATTACK',
])

export function getInterventionTuning(settings: MeetingAgentSettings): InterventionTuning {
  return LEVEL_TUNING[settings.interventionLevel]
}

/**
 * Effective confidence threshold for a specific reason, combining intervention
 * level with the personality's priorities.
 */
export function thresholdForReason(settings: MeetingAgentSettings, reason: InterventionReason): number {
  const base = LEVEL_TUNING[settings.interventionLevel].confidenceThreshold
  const isPriority = PERSONALITY_PRIORITY_REASONS[settings.personality].has(reason)
  return isPriority ? Math.max(0.3, base - PRIORITY_THRESHOLD_DISCOUNT) : base
}

export function isUrgentReason(reason: InterventionReason | undefined): boolean {
  return reason !== undefined && URGENT_REASONS.has(reason)
}
