/**
 * Meeting-agent configuration: how Urushi behaves, sounds and intervenes in a
 * live Google Meet / Zoom conversation.
 *
 * Two axes are deliberately kept independent (spec §7): PERSONALITY is *how*
 * Urushi speaks, INTERVENTION LEVEL is *how often*. "Chair personality +
 * Chair-the-meeting level" is a valid, deliberately strong combination — the
 * tuning table below composes both rather than branching on a single enum.
 *
 * Everything here is pure data + pure functions so the intervention engine and
 * the prompt builder can be unit-tested without any I/O.
 */

export type MeetingPersonality = 'chair' | 'straight_shooter'
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
  personality: 'chair',
  voiceGender: 'female',
  region: 'american',
  language: 'auto',
  interventionLevel: 'facilitator',
  languageStyle: 'direct',
}

const PERSONALITIES: readonly MeetingPersonality[] = ['chair', 'straight_shooter']
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
  const personality = pick(PERSONALITIES, r.personality, DEFAULT_MEETING_AGENT_SETTINGS.personality)
  return {
    personality,
    voiceGender: pick(VOICE_GENDERS, r.voiceGender, DEFAULT_MEETING_AGENT_SETTINGS.voiceGender),
    region: pick(REGIONS, r.region, DEFAULT_MEETING_AGENT_SETTINGS.region),
    language: pick(LANGUAGES, r.language, DEFAULT_MEETING_AGENT_SETTINGS.language),
    interventionLevel: pick(INTERVENTION_LEVELS, r.interventionLevel, DEFAULT_MEETING_AGENT_SETTINGS.interventionLevel),
    // Chair never uses profanity — the control is hidden in the UI (spec §6) and
    // forced here too so a hand-crafted API call can't route around it.
    languageStyle: personality === 'chair'
      ? 'clean'
      : pick(LANGUAGE_STYLES, r.languageStyle, DEFAULT_MEETING_AGENT_SETTINGS.languageStyle),
  }
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
  chair: new Set<InterventionReason>([
    'AGENDA_DRIFT', 'DOMINATING_PARTICIPANT', 'DECISION_READY', 'NEXT_STEP_NEEDED', 'UNANSWERED_QUESTION',
    'VAGUENESS',
  ]),
  straight_shooter: new Set<InterventionReason>([
    'CONTRADICTION', 'CIRCULAR_DISCUSSION', 'UNANSWERED_QUESTION', 'FACT_VS_INTERPRETATION',
    'VAGUENESS', 'UNSUPPORTED_CLAIM',
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
