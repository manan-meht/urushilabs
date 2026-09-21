/**
 * Language and register direction.
 *
 * Two things are configured here and they are not the same: WHICH language
 * Urushi speaks, and WHICH SCRIPT it writes in. Script only matters where there
 * is text to render — a voice session has no script, and asking about one would
 * be meaningless.
 *
 * The Hinglish register guidance is inherited from room mode
 * (src/lib/ai/room/spokenLanguage.ts), where it was written against a real
 * failure: asked for Hindi, the model reached for the formal written register it
 * saw most of in training and produced "aap dono ke beech kaam ka vibhajan ek
 * mahatvapurn vishay hai". Correct Hindi, and completely wrong for two people
 * arguing about housework. Naming the exact words it reached for is what moved
 * it; "speak naturally" did not, because the model believes it already is.
 */

import type { ConversationLanguage, TextScript } from '@/lib/conversation/settings'

const LANGUAGE_ENGLISH = `# Language: English
Speak in English. Plain, conversational English — not legalese, not therapy-speak.`

const LANGUAGE_HINDI = `# Language: Hindi
Speak in Hindi, the way people actually speak it — conversational, not literary or bureaucratic.

Do not reach for Sanskritised vocabulary when an everyday word exists. Ordinary Hindi speech borrows English words constantly and you should too: "office", "meeting", "budget", "deadline", "project" are said in English by Hindi speakers, so say them in English rather than translating them into words nobody uses out loud.

Wrong register: "kaam ke vibhajan ka prashn mahatvapurn hai".
Right register: "kaam ka baatwara hi asli issue hai".

Never translate the participants' names.`

const LANGUAGE_HINGLISH = `# Language: Hinglish
Speak in Hinglish — the everyday code-mixed Hindi-English people actually use, not formal Hindi with occasional English words bolted on.

Keep English for anything work-related, technical or modern; let Hindi carry the connective tissue of the sentence. Do NOT reach for Sanskritised vocabulary when an English word is what people actually say:

  say "work" or "kaam", not "karya"
  say "split" or "baatna", not "vibhajan"
  say "important", not "mahatvapurn"
  say "decision", not "nirnay"
  say "apna point rakhna" or "share karna", not "vichar vyakt karna"
  say "team" / "office" / "meeting" / "budget" — never translate these

"Mujhe lagta hai ki work ka split hi main issue hai" is right. "Kaam ke vibhajan ka prashn mahatvapurn hai" is wrong, even though it is better Hindi.

Never translate the participants' names.`

const LANGUAGE_MODULES: Record<ConversationLanguage, string> = {
  english: LANGUAGE_ENGLISH,
  hindi: LANGUAGE_HINDI,
  hinglish: LANGUAGE_HINGLISH,
}

const SCRIPT_DIRECTION: Record<TextScript, string> = {
  devanagari: 'Write in Devanagari script (देवनागरी). Keep English loanwords in Latin script where that is how they are normally written.',
  roman: 'Write in Latin/Roman script, not Devanagari — the way people type Hindi in chat.',
}

/**
 * Language direction for a prompt.
 *
 * `includeScript` must be false for voice, where the model speaks rather than
 * writes and a script instruction is noise at best. English never gets a script
 * direction either, since there is no choice to make.
 */
export function buildLanguageDirection(
  language: ConversationLanguage,
  opts: { script?: TextScript; includeScript?: boolean } = {}
): string {
  const base = LANGUAGE_MODULES[language]
  if (!opts.includeScript || !opts.script || language === 'english') return base
  return `${base}\n\n${SCRIPT_DIRECTION[opts.script]}`
}

/**
 * A short reminder for the END of a prompt, where instructions carry more weight
 * than buried in the middle.
 *
 * Earned its place in meeting mode: with a fully-Hindi transcript the model kept
 * replying in English despite the language module above, and moving a one-line
 * reminder to final position took correct switches from 0/6 to 4/6.
 *
 * English gets one too. It originally did not, on the reasoning that English is
 * the default and there is no choice to make — which is true only until the room
 * speaks something else. A case set to English with participants talking
 * Hinglish was answered in Hinglish every time, because the pull of the
 * transcript is just as strong in this direction and nothing in final position
 * pushed back. The asymmetry, not the wording, was the bug.
 */
export function buildLanguageReminder(language: ConversationLanguage): string {
  if (language === 'english') {
    return 'Language check: reply in English, even if the participants are speaking Hindi or Hinglish. ' +
      'They chose English for your replies. Keep their words as they said them when you quote them.'
  }
  const name = language === 'hindi' ? 'Hindi' : 'Hinglish'
  return `Language check: reply in conversational ${name}, not English.`
}
