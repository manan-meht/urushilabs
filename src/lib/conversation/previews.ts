/**
 * Static preview lines for the style picker.
 *
 * Deliberately hand-written rather than generated. A preview is shown every time
 * someone opens the picker and toggles between three cards — generating them
 * would mean a model call per toggle, for text that never changes, with latency
 * in front of a control people click idly. These are also the only place the
 * personalities can be compared on identical input, which is the entire point.
 *
 * Every style answers the SAME scenario, so the difference on screen is the
 * style and nothing else.
 *
 * Keyed by LANGUAGE AND SCRIPT, not language alone. Those are two separate
 * choices — Hindi can be written in Devanagari or in Roman — and an earlier
 * version keyed only off language, so a user who picked Roman script was shown
 * Devanagari and reasonably concluded the setting did nothing. A preview that
 * ignores the setting it is previewing is worse than no preview.
 *
 * The non-English versions are written, not translated. A literal rendering of
 * the English produces exactly the stiff, over-formal register that
 * src/lib/ai/persona/language.ts exists to prevent, and it would be dishonest to
 * preview a voice the product will not actually use.
 */

import type { ConversationLanguage, MediatorPersonality, TextScript } from './settings'

/** English has no script choice, so its entry is shared by both. */
type ScriptVariants = Record<TextScript, string>
type LocalisedPreview = Record<ConversationLanguage, ScriptVariants>

function sameInBothScripts(text: string): ScriptVariants {
  return { devanagari: text, roman: text }
}

const SCENARIOS: LocalisedPreview = {
  english: sameInBothScripts(
    'One person missed an agreed deadline and says they were overwhelmed. The other person had to cover for them.'
  ),
  hindi: {
    devanagari:
      'एक व्यक्ति तय की हुई डेडलाइन मिस कर गया और कहता है कि वह बहुत दबाव में था। दूसरे को उसका काम संभालना पड़ा।',
    roman:
      'Ek vyakti tay ki hui deadline miss kar gaya aur kehta hai ki wo bahut dabaav mein tha. Doosre ko uska kaam sambhalna pada.',
  },
  hinglish: {
    roman:
      'Ek person ne agreed deadline miss kar di aur kehta hai ki wo overwhelmed tha. Doosre ko uska kaam cover karna pada.',
    devanagari:
      'एक person ने agreed deadline miss कर दी और कहता है कि वो overwhelmed था। दूसरे को उसका काम cover करना पड़ा।',
  },
}

const DIPLOMAT: LocalisedPreview = {
  english: sameInBothScripts(
    'The missed deadline left you carrying extra work, while you were feeling overwhelmed. Let’s clarify what happened and agree on how delays should be communicated.'
  ),
  hindi: {
    devanagari:
      'डेडलाइन मिस होने से सारा काम आप पर आ गया, और उधर आप पहले से ही बहुत दबाव में थे। पहले साफ़ कर लेते हैं कि हुआ क्या, फिर तय करते हैं कि देरी हो तो बताना कैसे है।',
    roman:
      'Deadline miss hone se saara kaam aap par aa gaya, aur udhar aap pehle se hi bahut dabaav mein the. Pehle saaf kar lete hain ki hua kya, phir tay karte hain ki deri ho to batana kaise hai.',
  },
  hinglish: {
    roman:
      'Deadline miss hone se extra kaam aap par aa gaya, aur unki taraf se pressure bhi real tha. Pehle ye clear kar lete hain ki hua kya, phir decide karte hain ki delay ho toh batana kaise hai.',
    devanagari:
      'Deadline miss होने से extra काम आप पर आ गया, और उनकी तरफ़ से pressure भी real था। पहले ये clear कर लेते हैं कि हुआ क्या, फिर decide करते हैं कि delay हो तो बताना कैसे है।',
  },
}

const STRAIGHT_SHOOTER_CLEAN: LocalisedPreview = {
  english: sameInBothScripts(
    'You missed the deadline without warning. Being overwhelmed explains the delay, but it doesn’t remove your responsibility to communicate. On that point, your partner is right.'
  ),
  hindi: {
    devanagari:
      'आपने डेडलाइन मिस की और बताया तक नहीं। दबाव में होना देरी की वजह हो सकती है, ज़िम्मेदारी से छूट नहीं। इस बात पर सामने वाला सही है।',
    roman:
      'Aapne deadline miss ki aur bataya tak nahi. Dabaav mein hona deri ki wajah ho sakti hai, zimmedari se chhoot nahi. Is baat par saamne wala sahi hai.',
  },
  hinglish: {
    roman:
      'Aapne deadline miss ki aur bataya tak nahi. Overwhelmed hona delay explain karta hai, lekin batane ki responsibility khatam nahi karta. Is point par unki baat sahi hai.',
    devanagari:
      'आपने deadline miss की और बताया तक नहीं। Overwhelmed होना delay explain करता है, लेकिन बताने की responsibility खत्म नहीं करता। इस point पर उनकी बात सही है।',
  },
}

/**
 * Only reachable with profanity explicitly on, which only the Straight Shooter
 * offers. Shown in the picker so nobody enables it without seeing what they are
 * actually agreeing to — the swearing is aimed at the excuse, never the person.
 */
const STRAIGHT_SHOOTER_PROFANE: LocalisedPreview = {
  english: sameInBothScripts(
    'Being overwhelmed is understandable. Using it to dodge responsibility for not communicating is a bullshit excuse. Your partner was left covering for you.'
  ),
  hindi: {
    devanagari:
      'दबाव में होना समझ आता है। लेकिन उसी की आड़ में ये कहना कि बताने की ज़रूरत ही नहीं थी — ये बकवास बहाना है। पूरा काम सामने वाले ने संभाला।',
    roman:
      'Dabaav mein hona samajh aata hai. Lekin usi ki aad mein ye kehna ki batane ki zaroorat hi nahi thi — ye bakwaas bahana hai. Poora kaam saamne wale ne sambhala.',
  },
  hinglish: {
    roman:
      'Overwhelmed hona samajh aata hai. Lekin usi ko use karke batane ki responsibility se bachna — that’s a bullshit excuse. Unhone aapka kaam cover kiya.',
    devanagari:
      'Overwhelmed होना समझ आता है। लेकिन उसी को use करके बताने की responsibility से बचना — that’s a bullshit excuse. उन्होंने आपका काम cover किया।',
  },
}

const DEAL_MAKER: LocalisedPreview = {
  english: sameInBothScripts(
    'Let’s agree on three things: who finishes the remaining work, the new deadline, and how much warning either of you must give if a deadline is at risk.'
  ),
  hindi: {
    devanagari:
      'तीन चीज़ें तय कर लेते हैं: बचा हुआ काम कौन पूरा करेगा, नई डेडलाइन क्या होगी, और आगे कोई डेडलाइन फँसती दिखे तो कितने पहले बताना है।',
    roman:
      'Teen cheezein tay kar lete hain: bacha hua kaam kaun poora karega, nayi deadline kya hogi, aur aage koi deadline phansti dikhe to kitne pehle batana hai.',
  },
  hinglish: {
    roman:
      'Teen cheezein decide kar lete hain: bacha hua kaam kaun finish karega, nayi deadline kya hogi, aur agar aage koi deadline risk mein lage toh kitna pehle batana hai.',
    devanagari:
      'तीन चीज़ें decide कर लेते हैं: बचा हुआ काम कौन finish करेगा, नई deadline क्या होगी, और अगर आगे कोई deadline risk में लगे तो कितना पहले बताना है।',
  },
}

/** The scenario every style is answering, in the chosen language and script. */
export function getPreviewScenario(language: ConversationLanguage, script: TextScript): string {
  return SCENARIOS[language][script]
}

/**
 * The line this style would say to the shared scenario.
 *
 * `allowProfanity` only changes the Straight Shooter — it is forced false for
 * every other personality upstream, and passing true here for one is simply
 * ignored rather than trusted.
 */
export function getStylePreview(
  personality: MediatorPersonality,
  language: ConversationLanguage,
  script: TextScript,
  allowProfanity = false
): string {
  const table = personality === 'straight_shooter'
    ? (allowProfanity ? STRAIGHT_SHOOTER_PROFANE : STRAIGHT_SHOOTER_CLEAN)
    : personality === 'deal_maker'
      ? DEAL_MAKER
      : DIPLOMAT

  return table[language][script]
}
