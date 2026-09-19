/**
 * Conversation settings — the language Urushi speaks, the personality it adopts,
 * and whether it may swear. Shared by every conversation mode (invited intake,
 * together, room/live, meeting mediation).
 *
 * These live on `cases`, the one table every mode already hangs off, rather than
 * being duplicated per mode. Meeting Mediation's own settings
 * (src/lib/meeting/agentSettings.ts) keep the axes that are genuinely
 * meeting-specific — voice gender, accent region, how often to interrupt — and
 * defer to this module for the three that are not.
 *
 * Everything here is pure data and pure functions, so prompt construction and
 * validation are unit-testable with no I/O.
 *
 * Versioning: `version` increments whenever a setting changes, and participants
 * accept a specific version. That is what stops an acceptance gathered under
 * "Diplomat, no swearing" from silently authorising "Straight Shooter, swearing
 * on" — see acceptance.ts.
 */

export type ConversationLanguage = 'english' | 'hindi' | 'hinglish'
export type MediatorPersonality = 'diplomat' | 'straight_shooter' | 'deal_maker'

/**
 * Script for written output. Irrelevant to voice modes, where there is no text to
 * render — callers should hide the control rather than ask a meaningless question.
 */
export type TextScript = 'devanagari' | 'roman'

export interface ConversationSettings {
  language: ConversationLanguage
  personality: MediatorPersonality
  /**
   * Straight Shooter only. Any other personality forces this false, in the
   * normalizer as well as the UI — a hand-crafted API call must not be able to
   * route around a control the user cannot even see.
   */
  allowProfanity: boolean
  textScript: TextScript
  /** Bumped on every change; acceptances are recorded against a specific value. */
  version: number
}

export const CONVERSATION_LANGUAGES: readonly ConversationLanguage[] = ['english', 'hindi', 'hinglish']
export const MEDIATOR_PERSONALITIES: readonly MediatorPersonality[] = ['diplomat', 'straight_shooter', 'deal_maker']
export const TEXT_SCRIPTS: readonly TextScript[] = ['devanagari', 'roman']

export const CONVERSATION_LANGUAGE_LABELS: Record<ConversationLanguage, string> = {
  english: 'English',
  hindi: 'Hindi',
  hinglish: 'Hinglish',
}

export const MEDIATOR_PERSONALITY_LABELS: Record<MediatorPersonality, string> = {
  diplomat: 'The Diplomat',
  straight_shooter: 'The Straight Shooter',
  deal_maker: 'The Deal Maker',
}

export const MEDIATOR_PERSONALITY_DESCRIPTIONS: Record<MediatorPersonality, string> = {
  diplomat: 'Calm, balanced, and constructive. Helps you understand each other and find a way forward.',
  straight_shooter: 'Challenges excuses, calls out unfairness, and tells you whose argument holds up — and why.',
  deal_maker: 'Gets practical. Finds the trade-offs and turns disagreement into a workable agreement.',
}

/** Material Symbols names, matching the icon-in-a-circle treatment used across setup. */
export const MEDIATOR_PERSONALITY_ICONS: Record<MediatorPersonality, string> = {
  diplomat: 'handshake',
  straight_shooter: 'gavel',
  deal_maker: 'balance',
}

export const TEXT_SCRIPT_LABELS: Record<TextScript, string> = {
  devanagari: 'Devanagari (हिंदी)',
  roman: 'Roman (Hinglish)',
}

/**
 * Hindi is written in Devanagari; Hinglish is written in Roman. Both are only
 * defaults — a Hindi speaker who prefers Roman may say so, and for English there
 * is nothing to choose.
 */
export function defaultScriptForLanguage(language: ConversationLanguage): TextScript {
  return language === 'hindi' ? 'devanagari' : 'roman'
}

/** Script is only a meaningful choice for Hindi and Hinglish, and only in text modes. */
export function scriptIsRelevant(language: ConversationLanguage): boolean {
  return language !== 'english'
}

export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
  language: 'english',
  personality: 'diplomat',
  allowProfanity: false,
  textScript: 'roman',
  version: 1,
}

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/**
 * Turns anything — a partial row, a pre-migration NULL, an untrusted request
 * body — into a complete, self-consistent settings object.
 *
 * This is the only sanctioned way settings reach prompt construction. Unknown
 * enum values fall back to defaults rather than propagating, and the
 * profanity/personality invariant is enforced here rather than trusted from the
 * client.
 */
export function normalizeConversationSettings(
  raw: Partial<Record<keyof ConversationSettings, unknown>> | null | undefined
): ConversationSettings {
  const r = raw ?? {}
  const language = pick(CONVERSATION_LANGUAGES, r.language, DEFAULT_CONVERSATION_SETTINGS.language)
  const personality = pick(MEDIATOR_PERSONALITIES, r.personality, DEFAULT_CONVERSATION_SETTINGS.personality)

  const version = typeof r.version === 'number' && Number.isInteger(r.version) && r.version > 0
    ? r.version
    : DEFAULT_CONVERSATION_SETTINGS.version

  return {
    language,
    personality,
    // Only the Straight Shooter has a swearing control at all, so every other
    // personality resolves to false no matter what was stored or submitted.
    allowProfanity: personality === 'straight_shooter' ? r.allowProfanity === true : false,
    textScript: pick(TEXT_SCRIPTS, r.textScript, defaultScriptForLanguage(language)),
    version,
  }
}

/**
 * Whether two settings differ in a way participants must re-accept.
 *
 * Script is deliberately excluded: it changes how text is rendered, not what
 * Urushi will say or how bluntly, so re-gathering everyone's agreement for it
 * would train people to click through the thing that actually matters.
 */
export function requiresReacceptance(a: ConversationSettings, b: ConversationSettings): boolean {
  return a.language !== b.language
    || a.personality !== b.personality
    || a.allowProfanity !== b.allowProfanity
}

/** Maps DB snake_case columns to the settings object. */
export function conversationSettingsFromRow(row: {
  conversation_language?: unknown
  mediator_personality?: unknown
  allow_profanity?: unknown
  text_script?: unknown
  conversation_settings_version?: unknown
} | null | undefined): ConversationSettings {
  return normalizeConversationSettings({
    language: row?.conversation_language,
    personality: row?.mediator_personality,
    allowProfanity: row?.allow_profanity,
    textScript: row?.text_script,
    version: row?.conversation_settings_version,
  })
}

/** Maps the settings object to DB snake_case columns. */
export function conversationSettingsToRow(settings: ConversationSettings): {
  conversation_language: ConversationLanguage
  mediator_personality: MediatorPersonality
  allow_profanity: boolean
  text_script: TextScript
  conversation_settings_version: number
} {
  return {
    conversation_language: settings.language,
    mediator_personality: settings.personality,
    allow_profanity: settings.allowProfanity,
    text_script: settings.textScript,
    conversation_settings_version: settings.version,
  }
}
