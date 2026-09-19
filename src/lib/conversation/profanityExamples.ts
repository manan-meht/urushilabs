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
    text: 'Bhenchod, phir wahi gol-gol baat. Friday ka promise hua tha ya nahi?',
    note: 'An interjection, not a statement about anyone’s family.',
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
]

export const PROFANITY_HELPER_TEXT =
  'Urushi may use strong English and Hindi gaalis to express frustration or emphasis, without insulting participants.'

export const PROFANITY_TOGGLE_LABEL = 'Allow strong profanity'

/**
 * Shown alongside the examples. Says the two things people most need to know
 * before agreeing: it is never aimed at them, and they can withdraw it alone.
 */
export const PROFANITY_REASSURANCE =
  'Never aimed at you or anyone else in the conversation — no insults, threats or slurs. Anyone can turn this off at any time, on their own, and it stays off until everyone agrees again.'
