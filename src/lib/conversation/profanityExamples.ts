/**
 * What "strong language" actually means, shown before anyone agrees to it.
 *
 * The toggle's one-line helper cannot convey the intensity of what is being
 * permitted — and this setting permits real adult profanity, including
 * conventionally family-based Hindi expressions used idiomatically. Someone
 * agreeing to that deserves to see the register first, not discover it
 * mid-mediation.
 *
 * Deliberately shows the forbidden uses alongside the permitted ones. The
 * boundary is the reassuring part: the swearing is aimed at situations, never at
 * the people in the room, and seeing a rejected example makes that concrete in a
 * way "no personal abuse" does not.
 */

export interface ProfanityExample {
  text: string
  /** Why it is or isn't acceptable — shown beneath the line. */
  note: string
}

export const PROFANITY_PERMITTED_EXAMPLES: ProfanityExample[] = [
  {
    text: 'Fuck, we’re going in circles. What date can you actually commit to?',
    note: 'Frustration with the conversation, followed by something useful.',
  },
  {
    text: 'Bhenchod, phir wahi gol-gol baat. Abhi sirf yeh clear karte hain — Friday ka promise hua tha ya nahi?',
    note: 'An exclamation about the conversation going in circles — never about anyone’s family — followed by a specific question. Hindi and Hinglish only.',
  },
  {
    text: 'Yeh ‘communication gap’ wala explanation bullshit hai — you agreed, then didn’t update them.',
    note: 'Aimed at the excuse, and backed by what was actually said.',
  },
]

export const PROFANITY_FORBIDDEN_EXAMPLES: ProfanityExample[] = [
  {
    text: 'Tu chutiya hai.',
    note: 'Aimed at the person rather than the argument.',
  },
  {
    text: 'Stop being a fucking idiot.',
    note: 'An insult about someone’s intelligence. Never acceptable.',
  },
  {
    text: 'Bhenchod, tujhe samajh nahi aata?',
    note: 'The same word, aimed at a person rather than the situation. Never acceptable.',
  },
]

/**
 * Names the actual words AND how often they arrive. An early version said
 * "strong English and Hindi gaalis", which is accurate and tells you nothing.
 * Its replacement named the words but said "for emphasis or frustration", which
 * reads as occasional — and the mediator now swears in roughly three turns out
 * of four. Someone agreeing to that deserves to know the frequency before the
 * session, not to discover it in the room.
 *
 * "Aimed at the situation, never at you" is the other half, and the more
 * important one: it is the promise that does not change however often it swears.
 */
export const PROFANITY_HELPER_TEXT =
  'Swears in most replies \u2014 words like \u2018fuck\u2019 and \u2018bakwaas\u2019, and \u2018bhenchod\u2019 when things go in circles. ' +
  'Aimed at the situation, never at you.'

export const PROFANITY_TOGGLE_LABEL = 'Allow strong profanity'

/**
 * Shown alongside the examples. Says the two things people most need to know
 * before agreeing: it is never aimed at them, and they can withdraw it alone.
 */
export const PROFANITY_REASSURANCE =
  'Never aimed at you or anyone else in the conversation — no insults, threats or slurs. Anyone can turn this off at any time, on their own, and it stays off until everyone agrees again.'
