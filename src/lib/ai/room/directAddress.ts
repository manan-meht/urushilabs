/**
 * Detects a participant explicitly inviting Urushi to speak ("Urushi, what do
 * you think?"). Room Mode's whole design is to stay silent by default, which is
 * correct but leaves people with no way to pull the mediator in when they
 * actually want it — in real testing, participants addressed Urushi directly,
 * got silence, and reasonably concluded it was broken.
 *
 * Simpler than Meeting Mediation's equivalent (src/lib/ai/meeting/overrideCommands.ts):
 * that one also handles BACK_OFF with a decaying confidence penalty, which Room
 * Mode has no equivalent of. This is just the STEP_IN half.
 *
 * Deliberately deterministic pattern matching, not a model call — it gates
 * whether the (expensive) intervention path runs, so it must be free and instant.
 *
 * Bilingual because the room is. Transcription runs with English + Hindi
 * (src/lib/ai/realtime/config.ts), and a Hindi speaker asking for the mediator
 * gets neither the English phrasings nor a Latin-script name: the transcriber
 * renders it as उरुशी. An English-only matcher makes the feature unreachable for
 * exactly the people most likely to need it.
 */

/**
 * Urushi must be addressed by name. Without this, ordinary conversation between
 * participants ("what do you think?" asked of each other) would constantly pull
 * the mediator in — the exact over-intervention the design exists to prevent.
 *
 * No \b on the Devanagari forms: JavaScript's word boundary is defined over
 * [A-Za-z0-9_], so it matches *between* a Latin character and a Devanagari one
 * and never inside Devanagari text. Applying it here would silently break the
 * match. The spellings are distinctive enough to stand without one.
 */
const ADDRESSED_PATTERNS: RegExp[] = [
  /\burushi\b/i,
  // Devanagari renderings vary by transcription — the sibilant lands on श/ष/स
  // and the vowel length on both syllables is inconsistent.
  /उर[ुू][शषस][िी]/,
  // Known mis-transcription, not a spelling. In a Hindi-context sentence the
  // transcriber resolves the unfamiliar name to the nearest real word, and
  // पुरुषों (purushon, "men") is what it reaches for. Telling it not to — by
  // name, in the transcription prompt — was tried and did not hold, so the
  // corruption gets handled here instead.
  //
  // Safe despite पुरुषों being an ordinary word, because being named is only
  // half the test: an utterance genuinely about men still has to contain an
  // invitation to speak before this fires.
  /पुरुषो[ंन]?/,
  /पुरुष\b/,
]

/**
 * Being named alone isn't enough — people talk *about* the mediator ("Urushi has
 * been quiet"). These are the forms that actually invite it to speak.
 */
const INVITATION_PATTERNS: RegExp[] = [
  /\bstep in\b/i,
  /\bwhat do you think\b/i,
  /\bwhat'?s your (take|view|read|opinion)\b/i,
  /\byour thoughts\b/i,
  /\bweigh in\b/i,
  /\bhelp us\b/i,
  /\bresolve this\b/i,
  /\btake over\b/i,
  /\bany (thoughts|suggestions|advice)\b/i,
  /\bwhat should we\b/i,
  /\bcan you (say|tell|help|weigh|give|share)\b/i,
  /\bare you (there|listening|following)\b/i,
  /\bdo you have\b/i,

  // Hindi, Devanagari.
  /आप\s*क्या\s*(कहते|कहती|सोचते|सोचती|बोलते|बोलती)/,
  // "आपको क्या लगता है" — how it actually gets asked out loud, and the form this
  // originally missed: a participant said "उरुशी, आपको क्या लगता है?" live and
  // was refused on cooldown, because only the आप क्या कहते/सोचते shapes existed.
  /आपको\s*क्या\s*लग(ता|ती|ा)/,
  /क्या\s*कहना\s*है/,
  /आपक[ीा]\s*क्या\s*(राय|ख्याल|विचार)/,
  /कुछ\s*(बोलिए|बोलिये|बोलो|कहिए|कहिये|कहो)/,
  /मदद\s*(कीजिए|कीजिये|करिए|करिये|करो)/,
  /बता(इए|इये|ओ|एं|ाइए)/,
  /क्या\s*कर(ना\s*चाहिए|ें|ूं|ूँ)/,
  /सुन\s*रह[ेी]\s*(हैं|है|हो)/,
  /बीच\s*में\s*(आइए|आइये|आओ|बोलिए)/,
  /(सुलझा|हल\s*कर)(इए|इये|ओ|ना|ें)/,

  // Hindi, romanized — Hinglish speakers code-switch mid-sentence and the
  // transcriber follows whichever script the phrase was actually spoken in.
  /\baap\s*kya\s*(kehte|kehti|sochte|sochti|bolte|bolti)\b/i,
  /\baapko\s*kya\s*lag(ta|ti|a)\b/i,
  /\bkya\s*kehna\s*hai\b/i,
  /\b(ab\s*)?kya\s*kare[ln]?\b/i,
  /\baapk[ia]\s*kya\s*(raay|ray|khayal|vichar)\b/i,
  /\bkuch\s*(bolo|boliye|kaho|kahiye)\b/i,
  /\bmadad\s*(karo|kijiye|kijie|kariye)\b/i,
  /\bbata(iye|ao|o|yein)\b/i,
  /\bsun\s*rahe\s*(ho|hain|hai)\b/i,

  // A bare question directed at Urushi ("Urushi?") — short, addressed, and
  // interrogative is unambiguous enough to treat as an invitation.
  /\burushi\s*[?]/i,
  /उर[ुू][शषस][िी]\s*[?]/,
]

/**
 * True when this utterance is a participant asking Urushi to speak. Callers
 * should treat it as an override: bypass the listen-by-default posture and the
 * cooldown, because a person explicitly asking should always get an answer.
 */
export function detectDirectAddress(text: string): boolean {
  if (!text) return false
  if (!ADDRESSED_PATTERNS.some((pattern) => pattern.test(text))) return false

  // Named AND asking something. This carries most of the weight now, because
  // enumerating invitation phrasings kept losing: three natural ways of asking
  // — "आपको क्या लगता है", "आप कुछ बोलिए", "अब क्या करें" — each got silence in
  // live sessions until someone noticed and added a pattern for it. Guessing at
  // phrasings from outside the language does not converge.
  //
  // Talking ABOUT Urushi is almost always a statement ("Urushi has been quiet"),
  // so requiring a question mark keeps those out while catching anything
  // actually directed at it. The costs are lopsided too: a false positive is one
  // unnecessary sentence, rate-limited by the cooldown, while a false negative
  // reads as a broken device.
  if (/[?？]\s*$/.test(text.trim())) return true

  // Non-question invitations still need an explicit phrasing: "Urushi, step in."
  return INVITATION_PATTERNS.some((pattern) => pattern.test(text))
}
