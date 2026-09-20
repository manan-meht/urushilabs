/**
 * Detects a participant telling the mediator it is failing them — being
 * one-sided, letting someone off, repeating itself, or not actually helping.
 *
 * Deterministic, and deliberately not left to the prompt. Two attempts at
 * instructing the model to engage with these produced, in order: a generic
 * de-escalation, a polite request for more input, and a question about whether
 * there were other issues. Each was a different way of not answering, and each
 * time the prompt had a rule telling it not to do exactly that.
 *
 * Detecting it in code lets the instruction go in FINAL position, which is the
 * one place instructions have reliably held here — the same trick that fixed
 * language switching after the mid-prompt version failed.
 *
 * Over-triggering is the safer error: the cost is Urushi engaging with a
 * criticism that was not quite aimed at it, which is a good habit anyway.
 */

const CHALLENGE_PATTERNS: RegExp[] = [
  // English — one-sidedness and inaction.
  /\b(you'?re|you are|u r)\b[^.?!]{0,40}\b(not|n'?t)\b[^.?!]{0,25}\b(saying|doing|helping|asking|challenging|pushing)\b/i,
  /\byou'?re (being )?(one[- ]sided|biased|unfair|partial)\b/i,
  /\b(not|n'?t) (saying|telling|asking) (anything|nothing) to\b/i,
  /\byou (just )?(keep|kept) (saying|repeating|asking)\b/i,
  /\byou (said|says) (that|this|the same)\b[^.?!]{0,20}\b(twice|again|already)\b/i,
  /\b(that'?s|this is) (not|n'?t) (help(ing|ful)|an answer|useful)\b/i,
  /\byou'?re (not|n'?t) (giving|offering) (me |us )?(any )?(solution|answer|help)\b/i,
  /\bwhat (are|do) you (even )?(doing|do)\b/i,

  // Hindi / Hinglish — Devanagari.
  /आप\s*(कुछ\s*)?(बोल|कह)\s*(ही\s*)?नहीं\s*रहे/,
  /तुम\s*(कुछ\s*)?(बोल|कह)\s*(ही\s*)?नहीं\s*रहे/,
  /(को|से)\s*कुछ\s*(भी\s*)?नहीं\s*(बोल|कह)\s*रहे/,
  /(दो|२|2)\s*बार\s*(बोल|कह)\s*चुके/,
  /(वही|यही)\s*(बात|चीज़?)\s*(बार\s*बार|दोबारा)/,
  /कोई\s*(solution|हल|समाधान)\s*नहीं\s*दे\s*रहे/,
  /दिमाग\s*की\s*दही/,

  // Hindi / Hinglish — romanized.
  /\b(aap|tum)\s*(kuch\s*)?(bol|keh)\s*(hi\s*)?nahi\s*rahe/i,
  /\bdo\s*baar\s*(bol|keh)\s*chuke/i,
  /\bkoi\s*(solution|hal)\s*nahi\s*de\s*rahe/i,
  /\bdimaag\s*ki\s*dahi/i,
  /\b(wahi|yahi)\s*baat\s*(baar\s*baar|dobara)/i,
]

/** Typographic apostrophes come out of transcription and break naive patterns. */
function normalize(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'")
}

/**
 * True when this utterance is a complaint about the MEDIATOR rather than about
 * the other participant.
 *
 * Callers should treat it as requiring a substantive answer: name what went
 * unchallenged and challenge it, or explain in one sentence why the criticism is
 * wrong. Never a de-escalation, and never a request for more information.
 */
export function detectMediatorChallenge(text: string): boolean {
  if (!text) return false
  return CHALLENGE_PATTERNS.some((pattern) => pattern.test(normalize(text)))
}
