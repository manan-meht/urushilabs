/**
 * Central configuration for OpenAI's Realtime API (voice). Single source of truth for
 * which model/voice/transcription model Live Mediation uses, so it's never hardcoded
 * at each call site — verify against https://platform.openai.com/docs before changing
 * defaults, and confirm the model is actually available to this account.
 *
 * Session config (turn_detection, noise reduction) lives here too: the mediation
 * controller — not the Realtime API's own VAD — decides when Urushi speaks, so
 * create_response is always false. interrupt_response stays true so a participant
 * can still barge in over Urushi mid-sentence.
 */

import { getEnv } from '@/lib/env'

export interface RealtimeConfig {
  model: string
  transcribeModel: string
  voice: string
  /** ISO-639-1 codes the transcriber may choose between. Empty = unconstrained. */
  transcribeLanguages: string[]
}

export function getRealtimeConfig(): RealtimeConfig {
  const {
    OPENAI_REALTIME_MODEL,
    OPENAI_REALTIME_TRANSCRIBE_MODEL,
    OPENAI_REALTIME_VOICE,
    OPENAI_REALTIME_TRANSCRIBE_LANGUAGES,
  } = getEnv()
  return {
    model: OPENAI_REALTIME_MODEL,
    transcribeModel: OPENAI_REALTIME_TRANSCRIBE_MODEL,
    voice: OPENAI_REALTIME_VOICE,
    transcribeLanguages: OPENAI_REALTIME_TRANSCRIBE_LANGUAGES
      .split(',')
      .map((code) => code.trim())
      .filter(Boolean),
  }
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
}

/**
 * Domain + language steering for the transcriber, same technique as the intake
 * transcription prompt in src/lib/ai/voice.ts. Naming the expected languages
 * here is what keeps a bilingual room working while still discouraging the
 * transcriber from wandering into unrelated languages on unclear audio.
 */
export function buildTranscriptionPrompt(languageCodes: string[]): string {
  const base =
    'A live, in-person mediation conversation between people discussing a disagreement. ' +
    'Transcribe natural conversational speech. Do not invent content for unclear or silent audio. ' +
    // Naming the mediator matters more than it looks. "Urushi" is an unusual
    // proper noun the transcriber has no reason to expect, and on far-field
    // audio it gets mangled into whatever common word sounds closest — a real
    // attempt to address it came back as "जी, आप क्या हैं?", with the name gone
    // entirely. Direct address (src/lib/ai/room/directAddress.ts) requires the
    // name to survive transcription, so the whole feature depends on this line.
    'The AI mediator in the room is named Urushi, and participants sometimes address it by name; ' +
    'always spell that name "Urushi", whatever language the surrounding sentence is in.'

  if (languageCodes.length === 0) return base

  const names = languageCodes.map((code) => LANGUAGE_NAMES[code] ?? code)
  const spoken = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
  const mixNote = languageCodes.includes('en') && languageCodes.includes('hi')
    ? ' Speakers may code-switch mid-sentence (Hinglish); transcribe each phrase in the language actually spoken.'
    : ''

  return `${base} The speakers are talking in ${spoken}.${mixNote}`
}

/**
 * Session config sent when minting an ephemeral client secret. `instructions` (the
 * mediator system prompt) is supplied by the caller per-session since it depends on
 * participant names/topic/context.
 *
 * Everything lives under a `session` object with `type: "realtime"` — confirmed
 * against POST /v1/realtime/client_secrets's real response: sending `model` (or
 * `instructions`/`audio`) at the top level fails with "Unknown parameter: 'model'".
 * The route handler spreads this object's `session` key alongside its own
 * top-level `expires_after`.
 */
export function buildRealtimeSessionConfig(opts: { instructions: string }) {
  const { model, transcribeModel, voice, transcribeLanguages } = getRealtimeConfig()

  return {
    session: {
      type: 'realtime' as const,
      model,
      instructions: opts.instructions,
      audio: {
        input: {
          transcription: {
            model: transcribeModel,
            // Language steering goes in the prompt, NOT the `languages` field:
            // gpt-4o-transcribe rejects `languages` ("not supported for this
            // model"), and the singular `language` would pin exactly one, which
            // breaks bilingual rooms. The prompt biases without constraining.
            //
            // This matters: left with no steering at all, real far-field room
            // audio came back transcribed as Icelandic and Japanese — the model
            // will confidently guess a language on low-confidence audio.
            prompt: buildTranscriptionPrompt(transcribeLanguages),
          },
          noise_reduction: { type: 'far_field' },
          turn_detection: {
            type: 'semantic_vad',
            // Wait longer before closing a turn. At the default (auto ≈ medium),
            // real room audio came back shredded into fragments — "You know,",
            // "This need to be.", "मुझे लगता है कि" — each sent to the
            // intervention controller as a separate utterance. The controller
            // then judges sentence fragments instead of complete thoughts, which
            // biases it toward LISTEN and costs an API round trip per fragment.
            //
            // People in a room mid-disagreement pause to think, and pausing is
            // not finishing. 'low' is the right trade here: the cost is a little
            // more latency before Urushi may speak, which listen-by-default
            // makes nearly free.
            eagerness: 'low',
            // The mediation controller decides when Urushi speaks — never auto-reply.
            create_response: false,
            // Still let a participant's speech interrupt/cancel Urushi mid-response.
            interrupt_response: true,
          },
        },
        output: { voice },
      },
    },
  }
}
