/**
 * Urushi's opening line — the first thing the room hears, spoken once when a
 * session goes live.
 *
 * Kept out of the route (src/app/api/room/sessions/[id]/opening/route.ts) so the
 * wording is testable without standing up a request, a database and an OpenAI
 * call. The route owns idempotency and persistence; this file owns what gets
 * said.
 *
 * Exists because Room Mode listens by default. With nobody having raised a
 * dispute yet, the intervention controller correctly finds nothing to mediate,
 * so the device sits in silence — indistinguishable, to the people at the table,
 * from it being broken. An opening gives the room a way in.
 */

/**
 * Language for the opening, derived from the room's configured transcription
 * languages (OPENAI_REALTIME_TRANSCRIBE_LANGUAGES). Deliberately derived rather
 * than configured separately: a room that is transcribed for Hindi is a room
 * where people speak Hindi, and a second knob would only let the two drift.
 */
export type OpeningLanguage = 'english' | 'hinglish'

export function chooseOpeningLanguage(languageCodes: string[]): OpeningLanguage {
  return languageCodes.includes('hi') ? 'hinglish' : 'english'
}

/**
 * Hinglish is requested in Latin script, not Devanagari. Both are spoken
 * correctly by the Realtime voice, but Latin script is how Hinglish is actually
 * written, and it avoids the transcription-side confusion that turns the name
 * "Urushi" into पुरुषों (see src/lib/ai/room/directAddress.ts).
 */
const LANGUAGE_DIRECTION: Record<OpeningLanguage, string> = {
  english: 'Speak in English.',
  hinglish:
    'Speak in natural Hinglish — conversational Hindi mixed with English, the way people ' +
    'actually talk in an Indian office or home. Write it in Latin script, not Devanagari ' +
    '(for example: "Main Urushi hun", "aap dono", "shuru karte hain"). Do not produce ' +
    'formal or literary Hindi, and do not translate the participants\' names.',
}

/**
 * The instruction sent as the user turn when generating the opening. The room
 * persona (roomPrompt.ts) is the system turn, so this only has to describe the
 * moment and the shape of the reply.
 */
export function buildOpeningInstruction(languageCodes: string[]): string {
  return [
    'The session has just started and nobody has spoken yet. Say your opening line out loud: ',
    'greet them by name, say briefly who you are and that you will mostly listen and step in ',
    'when useful, name the topic, and invite one of them to start by describing how they see it. ',
    'Two or three sentences, warm and natural. ',
    LANGUAGE_DIRECTION[chooseOpeningLanguage(languageCodes)],
    ' Reply with ONLY the words you will say out loud.',
  ].join('')
}

/**
 * Used when there is no API key (DEMO_MODE). Deliberately a real, speakable line
 * rather than a placeholder — a demo where the mediator sits silent teaches the
 * wrong thing about how the product behaves.
 */
export function buildFallbackOpening(opts: {
  participantNames: string[]
  topic: string
  languageCodes: string[]
}): string {
  const names = opts.participantNames.join(' and ')
  const greeting = names || 'everyone'

  if (chooseOpeningLanguage(opts.languageCodes) === 'hinglish') {
    return `Hi ${greeting}. Main Urushi hun. Hum ${opts.topic} ke baare mein baat karne wale hain. Kaun shuru karna chahega?`
  }
  return `Hello ${greeting}. I'm Urushi. We're here to talk about ${opts.topic}. Who'd like to start?`
}
