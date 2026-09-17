/**
 * Maps user-facing voice choices (gender × region) onto a concrete TTS voice plus
 * delivery instructions.
 *
 * PROVIDER REALITY — read before extending:
 * OpenAI's TTS voices are not regional. There is no "Singaporean" or "Indian"
 * voice ID to select. What `gpt-4o-mini-tts` *does* support is a free-text
 * `instructions` field that steers delivery, including accent. So regional
 * character here comes from two places:
 *   1. picking the base voice whose timbre sits closest to the target, and
 *   2. steering accent/cadence through `instructions`.
 * That produces a recognisable but imperfect accent — noticeably weaker than a
 * provider with genuinely region-native voices (ElevenLabs, Azure Neural, Play.ht).
 *
 * This module is therefore the single seam for voice selection: it returns a
 * provider-agnostic VoiceProfile, and `synthesizeSpeech` consumes it. Swapping in
 * a provider with real regional voices means changing this file and the synthesis
 * call — nothing else in the meeting pipeline needs to know.
 *
 * Deliberately NOT exposed to users: raw voice IDs (spec §3).
 */

import type { AgentLanguage, MeetingAgentSettings, VoiceGender, VoiceRegion } from '@/lib/meeting/agentSettings'
import { effectiveLanguage } from '@/lib/meeting/agentSettings'

export interface VoiceProfile {
  /** Provider voice identifier. Never shown to users. */
  voice: string
  /** Delivery/accent steering passed to the TTS model. */
  instructions: string
  /** True when the accent is approximated via instructions rather than a native regional voice. */
  accentIsApproximated: boolean
}

/**
 * Base voice per gender. Chosen for a calm, professional, non-theatrical read —
 * these are the closest OpenAI voices to a neutral facilitator.
 */
const BASE_VOICE: Record<VoiceGender, string> = {
  female: 'sage',
  male: 'ash',
}

const REGION_ACCENT_INSTRUCTION: Record<VoiceRegion, string> = {
  american:
    'Speak in natural professional American English. Do not exaggerate regional slang or affect a broadcast-announcer tone.',
  singaporean:
    'ACCENT: Singaporean English. Use Singaporean vowel sounds, consonant-final clipping, and speech rhythm distinct from American English — this is the single most important instruction, apply it to every sentence. ' +
    'Register: an experienced Singaporean executive — clear, measured, professional. ' +
    'Do NOT perform a Singlish caricature — do not add "lah", "lor", "leh" or "sia", and do not exaggerate sentence-final particles.',
  indian:
    'ACCENT: Indian English. Use Indian English vowel sounds, consonant articulation (retroflex /t/ and /d/), and speech rhythm distinct from American English — this is the single most important instruction, apply it to every sentence. ' +
    'Register: an experienced Indian executive — clear, measured, professional. ' +
    'Do NOT perform a caricatured or sing-song Indian accent, and do not over-enunciate.',
}

const LANGUAGE_DELIVERY_INSTRUCTION: Partial<Record<AgentLanguage, string>> = {
  hindi:
    'The text is conversational Hindi. Deliver it as a fluent native Hindi speaker would in a professional setting — natural, not textbook or newsreader Hindi.',
  hinglish:
    'The text mixes Hindi and English the way urban Indian professionals speak. Deliver both languages fluently in one natural flow, without pausing at or over-articulating the switches.',
  auto:
    'The text may mix Hindi and English. Deliver whichever languages appear fluently and naturally, without pausing at the switches.',
}

/**
 * Delivery tone per personality. Chair is composed and authoritative; Straight
 * Shooter is faster and blunter. This is delivery only — wording comes from the
 * system prompt.
 */
const PERSONALITY_DELIVERY: Record<MeetingAgentSettings['personality'], string> = {
  chair:
    'Tone: composed, confident and decisive — a senior chairperson running the room. ' +
    'Measured conversational pace. Never sound tentative, apologetic, subordinate or theatrical.',
  straight_shooter:
    'Tone: direct, brisk and grounded — someone who cuts to the point. ' +
    'Slightly faster pace with firm emphasis. Never sound cruel, sneering or mocking.',
}

export function getVoiceProfile(settings: MeetingAgentSettings): VoiceProfile {
  const language = effectiveLanguage(settings)
  const parts = [
    PERSONALITY_DELIVERY[settings.personality],
    REGION_ACCENT_INSTRUCTION[settings.region],
  ]
  const languageDelivery = LANGUAGE_DELIVERY_INSTRUCTION[language]
  if (languageDelivery) parts.push(languageDelivery)

  return {
    voice: BASE_VOICE[settings.voiceGender],
    instructions: parts.join(' '),
    accentIsApproximated: settings.region !== 'american',
  }
}
