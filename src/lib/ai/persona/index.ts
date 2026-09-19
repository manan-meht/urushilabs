/**
 * Composes Urushi's mediator instructions from one shared foundation plus
 * independent personality, language and profanity modules.
 *
 * This is the single composition every AI entry point reuses — private intake,
 * live voice mediation, asynchronous exchanges, summaries and final reports — so
 * that a room which chose "Straight Shooter, Hinglish, swearing on" gets the
 * same mediator in its report as it had in the conversation.
 *
 * Callers add their own mode-specific sections AFTER this block: what a live
 * voice turn may sound like, what JSON a controller must return, how long a
 * report should be. Nothing mode-specific belongs in here.
 */

import type { ConversationSettings } from '@/lib/conversation/settings'
import { MEDIATOR_FOUNDATION, PERSONA_FOUNDATION_VERSION } from './foundation'
import { PERSONALITY_MODULES } from './personalities'
import { buildLanguageDirection, buildLanguageReminder } from './language'
import { buildProfanityDirection } from './profanity'

export { MEDIATOR_FOUNDATION, PERSONA_FOUNDATION_VERSION } from './foundation'
export { PERSONALITY_MODULES } from './personalities'
export { buildLanguageDirection, buildLanguageReminder } from './language'
export { buildProfanityDirection, PROFANITY_OFF, PROFANITY_ON } from './profanity'

export const MEDIATOR_PERSONA_VERSION = `${PERSONA_FOUNDATION_VERSION}`

export interface PersonaOptions {
  /**
   * Whether the output is written text the participants will read. Controls the
   * script direction, which is meaningless for speech — a voice session has no
   * script to choose.
   */
  written?: boolean
  /**
   * Whether this output is a durable RECORD — a report, a summary, structured
   * action items — rather than a turn in the conversation.
   *
   * Forces clean language even where swearing was agreed. A record is re-read
   * later, often alone and sometimes alongside a third party, without the
   * conversational context that made a word land as camaraderie rather than
   * aggression. Separate from `written` on purpose: a text mediation turn is
   * written but is not a record.
   */
  record?: boolean
}

/**
 * The mediator persona for these settings.
 *
 * Order matters. The foundation comes first so everything after it is read as a
 * refinement rather than a replacement; the profanity filter comes last of the
 * modules because it is the one most likely to be overridden by the surrounding
 * conversation's tone, and later instructions hold better.
 */
export function buildMediatorPersona(
  settings: ConversationSettings,
  opts: PersonaOptions = {}
): string {
  return [
    MEDIATOR_FOUNDATION,
    PERSONALITY_MODULES[settings.personality],
    buildLanguageDirection(settings.language, {
      script: settings.textScript,
      includeScript: opts.written === true,
    }),
    buildProfanityDirection(settings.allowProfanity, {
      record: opts.record === true,
      language: settings.language,
    }),
  ].join('\n\n')
}

/**
 * A one-line language reminder for the very end of a prompt, after any
 * mode-specific sections. Empty for English.
 *
 * Kept separate from buildMediatorPersona because it only works in final
 * position — that is the whole reason it exists. Callers that append their own
 * sections must add this themselves, last.
 */
export function buildPersonaLanguageReminder(settings: ConversationSettings): string {
  return buildLanguageReminder(settings.language)
}
