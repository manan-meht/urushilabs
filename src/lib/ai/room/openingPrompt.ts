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
 * from it being broken.
 *
 * The opening is personality-shaped. A Straight Shooter that opens with a
 * corporate welcome has already broken the promise the participants chose it
 * for, and the first ten seconds set what the room thinks this is.
 */

import type {
  ConversationLanguage,
  ConversationSettings,
  MediatorPersonality,
  TextScript,
} from '@/lib/conversation/settings'

export type OpeningLanguage = ConversationLanguage

/**
 * Whether the strong opening may be used.
 *
 * Deliberately NOT `settings.allowProfanity`. The setting says what was
 * proposed; this says what everyone actually accepted. The opening is the very
 * first thing anyone hears, so using the strong version on the strength of a
 * proposal nobody has agreed to would be the worst possible moment to get
 * consent wrong.
 */
export interface OpeningContext {
  settings: ConversationSettings
  /** Every required participant has accepted strong language specifically. */
  profanityAccepted: boolean
  /**
   * Something is already known about the dispute — an intake, a context
   * summary. Changes the opening from "tell me everything" to a specific first
   * question, because asking people to repeat what they already wrote down is
   * how you lose them in the first minute.
   */
  hasContext: boolean
  /**
   * Known signals of serious distress, fear, coercion or abuse. Overrides
   * personality entirely: no banter, no profanity, calm and direct.
   */
  safetyConcern?: boolean
}

type ScriptVariants = Record<TextScript, string>
type Localised = Record<ConversationLanguage, ScriptVariants>

function bothScripts(text: string): ScriptVariants {
  return { devanagari: text, roman: text }
}

/**
 * Reference openings — a register for the model to match, not text to emit
 * verbatim. The generated line still has to carry the participants' names and
 * the actual topic.
 */
const STRAIGHT_SHOOTER_STRONG: Localised = {
  hinglish: {
    roman: 'Chalo, ab seedhi baat karte hain. Gol-gol ghumana aur ek doosre ko chutiya banana — woh sab side mein rakho. Batao, hua kya?',
    devanagari: 'चलो, अब सीधी बात करते हैं। गोल-गोल घुमाना और एक दूसरे को चूतिया बनाना — वो सब साइड में रखो। बताओ, हुआ क्या?',
  },
  hindi: {
    devanagari: 'चलो, अब सीधी बात करते हैं। गोल-गोल घुमाना और एक दूसरे को चूतिया बनाना — वो सब साइड में रखो। बताओ, हुआ क्या?',
    roman: 'Chalo, ab seedhi baat karte hain. Gol-gol ghumana aur ek doosre ko chutiya banana — woh sab side mein rakho. Batao, hua kya?',
  },
  // Not a translation of the Hindi. An English room gets English bluntness;
  // importing gaalis into it would sound absurd rather than direct.
  english: bothScripts(
    'Right — let’s do this straight. No going round in circles, no bullshitting each other. So what actually happened?'
  ),
}

const STRAIGHT_SHOOTER_CLEAN: Localised = {
  hinglish: {
    roman: 'Chalo, ab seedhi baat karte hain. Gol-gol ghumane se kuch nahi hoga. Batao, hua kya?',
    devanagari: 'चलो, अब सीधी बात करते हैं। गोल-गोल घुमाने से कुछ नहीं होगा। बताओ, हुआ क्या?',
  },
  hindi: {
    devanagari: 'चलो, अब सीधी बात करते हैं। गोल-गोल घुमाने से कुछ नहीं होगा। बताओ, हुआ क्या?',
    roman: 'Chalo, ab seedhi baat karte hain. Gol-gol ghumane se kuch nahi hoga. Batao, hua kya?',
  },
  english: bothScripts(
    'Right — let’s do this straight. Going round in circles won’t help either of you. So what actually happened?'
  ),
}

const DIPLOMAT_OPENINGS: Localised = {
  hinglish: {
    roman: 'Hi dono ko. Main Urushi hun. Main mostly sunungi aur jahan useful lage wahan step in karungi. Shuru karte hain — aap ise kaise dekhte hain?',
    devanagari: 'हाय दोनों को। मैं उरुशी हूँ। मैं ज़्यादातर सुनूँगी और जहाँ ज़रूरी लगे वहाँ बात करूँगी। शुरू करते हैं — आप इसे कैसे देखते हैं?',
  },
  hindi: {
    devanagari: 'नमस्ते। मैं उरुशी हूँ। मैं ज़्यादातर सुनूँगी और जहाँ ज़रूरी लगे वहीं बोलूँगी। शुरू करते हैं — आप इसे कैसे देखते हैं?',
    roman: 'Namaste. Main Urushi hun. Main zyadatar sunungi aur jahan zaroori lage wahin bolungi. Shuru karte hain — aap ise kaise dekhte hain?',
  },
  english: bothScripts(
    'Hello both. I’m Urushi. I’ll mostly listen and step in where it helps. Let’s start — how do you see this?'
  ),
}

const DEAL_MAKER_OPENINGS: Localised = {
  hinglish: {
    roman: 'Theek hai — hum yahan ek workable agreement tak pahunchne aaye hain. Pehle ye samajh lein ki dono ko chahiye kya. Aap se shuru karein?',
    devanagari: 'ठीक है — हम यहाँ एक workable agreement तक पहुँचने आए हैं। पहले ये समझ लें कि दोनों को चाहिए क्या। आप से शुरू करें?',
  },
  hindi: {
    devanagari: 'ठीक है — हम यहाँ एक ऐसा हल निकालने आए हैं जो दोनों को चले। पहले ये साफ़ कर लें कि दोनों को चाहिए क्या। आप से शुरू करें?',
    roman: 'Theek hai — hum yahan ek aisa hal nikalne aaye hain jo dono ko chale. Pehle ye saaf kar lein ki dono ko chahiye kya. Aap se shuru karein?',
  },
  english: bothScripts(
    'Alright — we’re here to get to something you can both live with. Let’s start with what each of you actually needs. Shall we begin with you?'
  ),
}

/**
 * Overrides every personality. Nobody in genuine distress needs banter, and a
 * blunt opening would land as hostility from the one party meant to be safe.
 */
const SAFETY_OPENINGS: Localised = {
  hinglish: {
    roman: 'Main Urushi hun, aur main yahan sunne ke liye hun. Koi jaldi nahi hai. Jab aap tayyar hon, bataiye kya ho raha hai.',
    devanagari: 'मैं उरुशी हूँ, और मैं यहाँ सुनने के लिए हूँ। कोई जल्दी नहीं है। जब आप तैयार हों, बताइए क्या हो रहा है।',
  },
  hindi: {
    devanagari: 'मैं उरुशी हूँ, और मैं यहाँ सुनने के लिए हूँ। कोई जल्दी नहीं है। जब आप तैयार हों, बताइए क्या हो रहा है।',
    roman: 'Main Urushi hun, aur main yahan sunne ke liye hun. Koi jaldi nahi hai. Jab aap tayyar hon, bataiye kya ho raha hai.',
  },
  english: bothScripts(
    'I’m Urushi, and I’m here to listen. There’s no rush. When you’re ready, tell me what’s going on.'
  ),
}

/** The reference opening for these settings, before names and topic are woven in. */
export function getReferenceOpening(ctx: OpeningContext): string {
  const { language, textScript, personality } = ctx.settings

  if (ctx.safetyConcern) return SAFETY_OPENINGS[language][textScript]

  if (personality === 'straight_shooter') {
    // Consent, not configuration. Strong only when everyone actually accepted.
    const table = ctx.profanityAccepted && ctx.settings.allowProfanity
      ? STRAIGHT_SHOOTER_STRONG
      : STRAIGHT_SHOOTER_CLEAN
    return table[language][textScript]
  }

  if (personality === 'deal_maker') return DEAL_MAKER_OPENINGS[language][textScript]
  return DIPLOMAT_OPENINGS[language][textScript]
}

/**
 * The instruction sent as the user turn when generating the opening. The room
 * persona is the system turn, so this only describes the moment and the shape of
 * the reply.
 */
export function buildOpeningInstruction(ctx: OpeningContext): string {
  const reference = getReferenceOpening(ctx)

  if (ctx.safetyConcern) {
    return [
      'The session has just started. Something in what is already known suggests distress, fear, coercion or ',
      'abuse, so open calmly and directly — no banter, no strong language, no performance of personality. ',
      'Greet them, say briefly who you are, and invite them to talk when they are ready. ',
      `Match this register: "${reference}" `,
      'Two sentences. Reply with ONLY the words you will say out loud.',
    ].join('')
  }

  const contextLine = ctx.hasContext
    ? 'You already know roughly what this is about, so do NOT ask them to explain everything from scratch — ' +
      'name the actual issue in a few words and ask one specific, useful first question about it. '
    : 'Nobody has described the dispute yet, so name the topic and ask one of them to say how they see it. '

  return [
    'The session has just started and nobody has spoken yet. Say your opening line out loud: ',
    'greet them by name, make clear who you are in a few words, and set the tone for how this will go. ',
    contextLine,
    'Do NOT give a corporate welcome, and do NOT explain your personality at length — show it instead. ',
    `Match the register and length of this reference opening: "${reference}" `,
    'Two or three sentences, no more. ',
    'Setting expectations is not an accusation: do not imply either person has already lied or behaved unfairly. ',
    'Reply with ONLY the words you will say out loud.',
  ].join('')
}

/**
 * Used when there is no API key (DEMO_MODE). A real, speakable line rather than
 * a placeholder — a demo where the mediator sits silent teaches the wrong thing
 * about how the product behaves.
 */
export function buildFallbackOpening(ctx: OpeningContext & { participantNames: string[]; topic: string }): string {
  const names = ctx.participantNames.join(' and ')
  const greeting = names || 'everyone'
  const reference = getReferenceOpening(ctx)

  return ctx.settings.personality === 'straight_shooter' && !ctx.safetyConcern
    ? `${greeting} — ${reference}`
    : `${greeting}. ${reference}`
}
