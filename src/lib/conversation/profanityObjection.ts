/**
 * Detects someone asking the mediator to stop swearing, or saying the language
 * is making them uncomfortable.
 *
 * Deliberately deterministic pattern matching rather than a model call, and
 * deliberately NOT left to the prompt. Asking the mediator to stop and being
 * sworn at again is a trust failure you do not get to recover from, and the
 * prompt is the layer that has repeatedly failed to hold in this codebase —
 * the transcription prompt could not be made to spell "Urushi", and a
 * three-tier profanity instruction still reached for a polite synonym. A
 * withdrawal of consent should not depend on a model choosing to comply.
 *
 * Tuned to over-trigger rather than under-trigger. A false positive turns
 * swearing off for a conversation that would have tolerated it, and anyone can
 * propose turning it back on. A false negative means someone asked to stop and
 * was ignored.
 */

const OBJECTION_PATTERNS: RegExp[] = [
  // Direct requests, English.
  /\b(stop|don'?t|do not|quit|no more|enough)\b[^.?!]{0,30}\b(swear|swearing|cuss|cussing|curs(e|ing)|profanity|bad language|strong language|gaali|gaaliyan|galiyan)\b/i,
  /\b(swear|swearing|profanity|language)\b[^.?!]{0,20}\b(is )?(too much|not ok|not okay|unnecessary|uncalled for|inappropriate|offensive)\b/i,
  /\bwatch (your|the) (language|mouth)\b/i,
  /\b(please )?(be|keep it|keep things) (civil|polite|clean|respectful)\b/i,
  /\bno need (to|for) (swear|swearing|that language|gaali)/i,
  /\b(that|this) (kind of )?language\b[^.?!]{0,25}\b(isn'?t|is not|not)\b[^.?!]{0,15}\b(helping|helpful|ok|okay|necessary|appropriate)\b/i,
  /\bturn off (the )?(swearing|profanity|strong language)\b/i,
  /\bi'?m (not )?(comfortable|uncomfortable)\b[^.?!]{0,30}\b(language|swearing|gaali)\b/i,

  // Hindi / Hinglish, Devanagari.
  /गाली\s*(मत|ना|नहीं)\s*(दो|दीजिए|दीजिये|द[ेें])/,
  /(मत|ना|नहीं)\s*गाली/,
  /(अच्छा|ठीक)\s*नहीं\s*लग(ा|ता|ती)[^।?!]{0,20}(गाली|भाषा)/,
  /(भाषा|language)\s*(ठीक|सही)\s*नहीं/,
  /तमीज़?\s*से\s*(बात|बोल)/,

  // Hindi / Hinglish, romanized.
  /\bgaali(yan|yaan)?\s*(mat|na|nahi|nahin)\s*(do|dijiye|de)/i,
  /\b(mat|na|nahi|nahin)\s*gaali/i,
  /\btameez\s*se\s*(baat|bol)/i,
  /\b(achha|acha|theek)\s*nahi\s*lag/i,
]

/**
 * Transcription emits typographic apostrophes, so "don’t" never matched a
 * pattern written with "don't". Normalising here rather than doubling every
 * regex — a missed objection is the one failure mode this module must not have,
 * and the near-miss was only caught because a test happened to be typed with a
 * curly quote.
 */
function normalize(text: string): string {
  return text.replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"')
}

/**
 * True when this utterance asks the mediator to stop using strong language, or
 * says the language is unwelcome.
 *
 * Callers should treat it as an immediate withdrawal of consent: turn profanity
 * off for the session at once, without waiting for anyone else to agree. Turning
 * it back on goes through the full proposal flow.
 */
export function detectProfanityObjection(text: string): boolean {
  if (!text) return false
  return OBJECTION_PATTERNS.some((pattern) => pattern.test(normalize(text)))
}
