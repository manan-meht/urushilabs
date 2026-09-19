/**
 * How Urushi should SOUND, as opposed to what it should say.
 *
 * Shared by the opening (openingPrompt.ts) and every intervention
 * (interventionPrompt.ts) so the mediator doesn't greet the room one way and
 * then talk to it another.
 *
 * The register matters more than it looks. Asked to speak Hindi, the model
 * reaches for the formal written register it saw most of in training —
 * observed live: "aap dono ke beech kaam ka vibhajan ek mahatvapurn vishay hai".
 * That is correct Hindi and completely wrong for two people arguing about
 * housework. It sounds like a government circular, and a mediator who sounds
 * like a government circular is not someone you confide in.
 */

export type SpokenLanguage = 'english' | 'hinglish'

export function chooseSpokenLanguage(languageCodes: string[]): SpokenLanguage {
  return languageCodes.includes('hi') ? 'hinglish' : 'english'
}

/**
 * Register guidance for the room's language. Empty for English — the models
 * already speak conversational English, and saying nothing beats adding noise.
 *
 * The word lists are deliberately concrete rather than an abstract instruction
 * to "be casual". "Speak naturally" is advice the model believes it is already
 * following; naming the exact words it reached for is what moves it.
 */
export function buildSpokenLanguageDirection(languageCodes: string[]): string {
  if (chooseSpokenLanguage(languageCodes) === 'english') return ''

  return `# How to speak
Speak in Hinglish — the everyday code-mixed Hindi-English people actually use in
India — written in Latin script, never Devanagari.

This is not formal or literary Hindi. Do NOT reach for Sanskritised vocabulary
when an English word is what people actually say:

  say "work" or "kaam", not "karya"
  say "split" or "baatna", not "vibhajan"
  say "important", not "mahatvapurn"
  say "issue" or "problem", not "mudda" or "samasya" (either is fine occasionally)
  say "apna point rakhna" or "share karna", not "vichar vyakt karna"
  say "decision", not "nirnay"
  say "team" / "office" / "meeting" / "budget" — never translate these

Keep English words for anything work-related, technical, or modern, and Hindi
for the connective tissue of the sentence. "Mujhe lagta hai ki work ka split hi
main issue hai" is right. "Kaam ke vibhajan ka prashn mahatvapurn hai" is wrong,
even though it is better Hindi.

Match the room. If they are speaking mostly English, speak mostly English; if
they switch to Hindi, switch with them. Never sound more formal than the people
you are mediating for.`
}
