/**
 * Cheap, deterministic language detection for the meeting agent's "auto" language
 * mode (spec: language=auto should follow whichever language the room is actually
 * speaking). Pure — no model call — so it costs nothing and runs on every
 * intervention without adding latency.
 *
 * Exists because asking the model to both infer the room's language AND generate
 * the reply in one step was unreliable in testing (see personaPrompt.ts's
 * languageReminder): telling it directly which language the room just used is a
 * much stronger signal than asking it to notice on its own.
 */

export type DetectedLanguage = 'hindi' | 'hinglish' | 'english'

const DEVANAGARI_RE = /[ऀ-ॿ]/

/**
 * Common romanized Hindi function words seen in casual/professional code-switched
 * conversation. Deliberately function words (not topic-specific content words) so
 * detection generalizes across whatever the meeting is actually about.
 */
// Deliberately excludes romanized Hindi words that collide with common English
// words ("the" for था/थे, "are" for अरे, "main" for मैं, "par" for पर, "tab" for तब,
// "ya" for या) — those caused real false positives on ordinary English sentences
// in testing. Losing a little detection sensitivity is a much better trade than
// misfiring on plain English.
const HINDI_MARKERS = new Set([
  'hai', 'hain', 'hoon', 'ho', 'tha', 'thi', 'nahi', 'nahin', 'haan', 'kyun', 'kyu',
  'kaise', 'kya', 'kaun', 'kab', 'kahan', 'kaha', 'karna', 'karo', 'karte', 'karta', 'karti',
  'kar', 'kiya', 'kiye', 'ki', 'ka', 'ke', 'ko', 'se', 'mein', 'hum', 'humein', 'hume',
  'tum', 'tumhe', 'aap', 'aapko', 'unhe', 'unko', 'uska', 'uski', 'uske', 'iska', 'iski', 'iske',
  'yeh', 'ye', 'yah', 'woh', 'wo', 'sab', 'sabko', 'bhi', 'abhi', 'phir', 'toh', 'lekin',
  'magar', 'aur', 'jab', 'agar', 'isliye', 'isiliye', 'matlab', 'yaar', 'arre',
  'bilkul', 'zaroor', 'zaroori', 'thoda', 'bahut', 'bohot', 'achha', 'accha', 'theek', 'thik',
  'sahi', 'galat', 'samajh', 'samjha', 'dekho', 'dekhna', 'suno', 'sunna', 'bolo', 'bolna',
  'chahiye', 'raha', 'rahi', 'rahe', 'jayega', 'jayegi', 'jaenge', 'hoga', 'hogi', 'honge',
])

/** Classifies a single utterance. Text with no words at all is treated as English (neutral default). */
export function detectSpokenLanguage(text: string): DetectedLanguage {
  if (!text || !text.trim()) return 'english'
  if (DEVANAGARI_RE.test(text)) return 'hindi'

  const words = text.toLowerCase().match(/[a-z']+/g) ?? []
  if (words.length === 0) return 'english'

  const hindiHits = words.filter((w) => HINDI_MARKERS.has(w)).length
  if (hindiHits === 0) return 'english'

  const ratio = hindiHits / words.length
  // Short, heavily-Hindi utterances ("yaar dekho, hume karna hai") and
  // majority-Hindi longer ones both count as Hindi rather than a thin Hinglish mix.
  if (ratio >= 0.5 || (hindiHits >= 2 && words.length <= 6)) return 'hindi'
  return 'hinglish'
}

/**
 * Determines which language the room is currently speaking, for the "auto" mode
 * reminder. Prefers the latest utterance; if it's too short to carry a reliable
 * signal (e.g. "haan", "okay", "right"), walks backward through recent transcript
 * lines until it finds one with enough words to classify confidently.
 */
export function detectRoomLanguage(
  latestUtteranceText: string,
  recentTranscriptTexts: readonly string[] = []
): DetectedLanguage {
  const MIN_WORDS_FOR_SIGNAL = 3

  const wordCount = (text: string) => (text.trim().match(/\S+/g) ?? []).length

  if (wordCount(latestUtteranceText) >= MIN_WORDS_FOR_SIGNAL) {
    return detectSpokenLanguage(latestUtteranceText)
  }

  for (let i = recentTranscriptTexts.length - 1; i >= 0; i--) {
    const line = recentTranscriptTexts[i] ?? ''
    if (wordCount(line) >= MIN_WORDS_FOR_SIGNAL) {
      return detectSpokenLanguage(line)
    }
  }

  // Nothing with enough signal — fall back to whatever the (short) latest line gives us.
  return detectSpokenLanguage(latestUtteranceText)
}
