/**
 * Server-only OpenAI audio helpers: transcription (speech-to-text) and
 * speech synthesis (text-to-speech). Never import from client components.
 */

import { getEnv } from '@/lib/env'
import { prepareTtsInput } from '@/lib/voice'

/**
 * Transcribes an audio File to text. Audio is held in memory only — never
 * persisted. Returns the transcript string.
 *
 * Uses fetch directly rather than the OpenAI SDK to ensure compatibility with
 * the Cloudflare Workers runtime, where the SDK's Node.js HTTP internals hang.
 */
export async function transcribeAudio(audioFile: File): Promise<string> {
  const { OPENAI_API_KEY } = getEnv()
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.')

  const model = process.env['OPENAI_TRANSCRIPTION_MODEL'] ?? 'whisper-1'

  const form = new FormData()
  form.append('file', audioFile, audioFile.name)
  form.append('model', model)
  form.append('response_format', 'json')
  form.append('prompt', "This is a private conflict-resolution intake. Preserve the speaker's wording. Common names and terms may include Urushi. Do not summarize.")

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OpenAI transcription failed (${res.status}): ${text}`)
  }

  const data = await res.json() as { text?: string }
  if (!data.text) throw new Error('Empty transcript returned from OpenAI.')
  return data.text
}

const TTS_INSTRUCTIONS =
  'Speak calmly, warmly, and neutrally. Use a measured conversational pace with short natural pauses. Do not sound judgmental, theatrical, overly cheerful, clinical, or authoritative.'

/**
 * Synthesises speech (MP3) from text. Truncates to the TTS input limit.
 * Returns the audio bytes.
 *
 * Uses fetch directly rather than the OpenAI SDK — see transcribeAudio's
 * comment above; the SDK's Node.js HTTP internals don't reliably complete
 * requests in the Cloudflare Workers runtime (confirmed failing here with
 * "Connection error" when called from the meeting webhook handler).
 */
export interface SynthesizeSpeechOptions {
  /** Provider voice id. Defaults to OPENAI_TTS_VOICE. */
  voice?: string
  /** Delivery/accent steering. Defaults to the neutral facilitator instructions. */
  instructions?: string
}

export async function synthesizeSpeech(text: string, options: SynthesizeSpeechOptions = {}): Promise<Buffer> {
  const { OPENAI_API_KEY } = getEnv()
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.')

  const { input } = prepareTtsInput(text)
  const voice = options.voice ?? process.env['OPENAI_TTS_VOICE'] ?? 'coral'

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env['OPENAI_TTS_MODEL'] ?? 'gpt-4o-mini-tts',
      voice,
      input,
      instructions: options.instructions ?? TTS_INSTRUCTIONS,
      response_format: 'mp3',
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OpenAI speech synthesis failed (${res.status}): ${text}`)
  }

  const arrayBuffer = await res.arrayBuffer()
  return Buffer.from(arrayBuffer)
}
