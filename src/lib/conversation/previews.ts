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
 * The Hindi and Hinglish versions are written, not translated. A literal
 * rendering of the English produces exactly the stiff, over-formal register that
 * src/lib/ai/persona/language.ts exists to prevent, and it would be dishonest to
 * preview a voice the product will not actually use.
 */

import type { ConversationLanguage, MediatorPersonality } from './settings'

export const PREVIEW_SCENARIO: Record<ConversationLanguage, string> = {
  english:
    'One person missed an agreed deadline and says they were overwhelmed. The other person had to cover for them.',
  hindi:
    'एक व्यक्ति तय की हुई डेडलाइन मिस कर गया और कहता है कि वह बहुत दबाव में था। दूसरे को उसका काम संभालना पड़ा।',
  hinglish:
    'Ek person ne agreed deadline miss kar di aur kehta hai ki wo overwhelmed tha. Doosre ko uska kaam cover karna pada.',
}

type PreviewsByLanguage = Record<ConversationLanguage, string>

const DIPLOMAT: PreviewsByLanguage = {
  english:
    'The missed deadline left you carrying extra work, while you were feeling overwhelmed. Let’s clarify what happened and agree on how delays should be communicated.',
  hindi:
    'डेडलाइन मिस होने से सारा काम आप पर आ गया, और उधर आप पहले से ही बहुत दबाव में थे। पहले साफ़ कर लेते हैं कि हुआ क्या, फिर तय करते हैं कि देरी हो तो बताना कैसे है।',
  hinglish:
    'Deadline miss hone se extra kaam aap par aa gaya, aur unki taraf se pressure bhi real tha. Pehle ye clear kar lete hain ki hua kya, phir decide karte hain ki delay ho toh batana kaise hai.',
}

const STRAIGHT_SHOOTER_CLEAN: PreviewsByLanguage = {
  english:
    'You missed the deadline without warning. Being overwhelmed explains the delay, but it doesn’t remove your responsibility to communicate. On that point, your partner is right.',
  hindi:
    'आपने डेडलाइन मिस की और बताया तक नहीं। दबाव में होना देरी की वजह हो सकती है, ज़िम्मेदारी से छूट नहीं। इस बात पर सामने वाला सही है।',
  hinglish:
    'Aapne deadline miss ki aur bataya tak nahi. Overwhelmed hona delay explain karta hai, lekin batane ki responsibility khatam nahi karta. Is point par unki baat sahi hai.',
}

/**
 * Only reachable with profanity explicitly on, which only the Straight Shooter
 * offers. Shown in the picker so nobody enables it without seeing what they are
 * actually agreeing to — the swearing is aimed at the excuse, never the person.
 */
const STRAIGHT_SHOOTER_PROFANE: PreviewsByLanguage = {
  english:
    'Being overwhelmed is understandable. Using it to dodge responsibility for not communicating is a bullshit excuse. Your partner was left covering for you.',
  hindi:
    'दबाव में होना समझ आता है। लेकिन उसी की आड़ में ये कहना कि बताने की ज़रूरत ही नहीं थी — ये बकवास बहाना है। पूरा काम सामने वाले ने संभाला।',
  hinglish:
    'Overwhelmed hona samajh aata hai. Lekin usi ko use karke batane ki responsibility se bachna — that’s a bullshit excuse. Unhone aapka kaam cover kiya.',
}

const DEAL_MAKER: PreviewsByLanguage = {
  english:
    'Let’s agree on three things: who finishes the remaining work, the new deadline, and how much warning either of you must give if a deadline is at risk.',
  hindi:
    'तीन चीज़ें तय कर लेते हैं: बचा हुआ काम कौन पूरा करेगा, नई डेडलाइन क्या होगी, और आगे कोई डेडलाइन फँसती दिखे तो कितने पहले बताना है।',
  hinglish:
    'Teen cheezein decide kar lete hain: bacha hua kaam kaun finish karega, nayi deadline kya hogi, aur agar aage koi deadline risk mein lage toh kitna pehle batana hai.',
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
  allowProfanity = false
): string {
  switch (personality) {
    case 'straight_shooter':
      return allowProfanity ? STRAIGHT_SHOOTER_PROFANE[language] : STRAIGHT_SHOOTER_CLEAN[language]
    case 'deal_maker':
      return DEAL_MAKER[language]
    case 'diplomat':
    default:
      return DIPLOMAT[language]
  }
}
