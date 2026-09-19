import { describe, it, expect } from 'vitest'
import { detectDirectAddress } from './directAddress'

describe('detectDirectAddress', () => {
  it('detects direct invitations to speak', () => {
    for (const text of [
      'Urushi, what do you think?',
      'Urushi, can you help us here?',
      "Urushi, what's your take on this?",
      'Urushi, step in please',
      'Hey Urushi, any thoughts?',
      'Urushi, are you there?',
      'Urushi?',
    ]) {
      expect(detectDirectAddress(text), text).toBe(true)
    }
  })

  it('ignores the same questions when asked of each other, not Urushi', () => {
    // This is the whole point of requiring the name — participants constantly ask
    // each other these things, and pulling the mediator in every time would be the
    // exact over-intervention the design prevents.
    for (const text of [
      'What do you think?',
      'Can you help me understand why?',
      "What's your take on the pricing?",
      'Any thoughts on that?',
      'Are you there?',
    ]) {
      expect(detectDirectAddress(text), text).toBe(false)
    }
  })

  it('ignores merely talking about Urushi', () => {
    for (const text of [
      'Urushi has been very quiet.',
      'I think Urushi is recording this.',
      'We should probably let Urushi listen for a while.',
    ]) {
      expect(detectDirectAddress(text), text).toBe(false)
    }
  })

  it('handles empty and malformed input', () => {
    expect(detectDirectAddress('')).toBe(false)
    expect(detectDirectAddress('   ')).toBe(false)
  })

  it('is case-insensitive about the name', () => {
    expect(detectDirectAddress('URUSHI, what do you think?')).toBe(true)
    expect(detectDirectAddress('urushi, can you help us?')).toBe(true)
  })

  describe('Hindi', () => {
    it('detects the name written in Devanagari', () => {
      // Transcription renders the name inconsistently — the sibilant lands on
      // श/ष/स and both vowels vary in length. All of these are the same name.
      for (const text of [
        'उरुशी, आप क्या कहते हैं?',
        'उरूशी, आप क्या सोचते हैं?',
        'उरुषी, आपकी क्या राय है?',
        'उरुसि, कुछ बोलिए',
      ]) {
        expect(detectDirectAddress(text), text).toBe(true)
      }
    })

    it('detects Hindi invitations to speak', () => {
      for (const text of [
        'उरुशी, आपका क्या ख्याल है?',
        'उरुशी, हमारी मदद कीजिए',
        'उरुशी, आप बताइए',
        'उरुशी, क्या करना चाहिए?',
        'उरुशी, आप सुन रहे हैं?',
        'उरुशी, बीच में आइए',
        'उरुशी, इसे सुलझाइए',
        'उरुशी?',
      ]) {
        expect(detectDirectAddress(text), text).toBe(true)
      }
    })

    it('detects romanized Hinglish invitations', () => {
      // Speakers code-switch mid-sentence, and the transcriber follows whichever
      // script the phrase was actually spoken in — so the Latin-script forms have
      // to work too, including with the name still in Devanagari.
      for (const text of [
        'Urushi, aap kya kehte hain?',
        'Urushi, aapki kya raay hai?',
        'Urushi, kuch boliye',
        'Urushi, madad karo yaar',
        'Urushi, aap bataiye',
        'उरुशी, aap kya sochte hain?',
      ]) {
        expect(detectDirectAddress(text), text).toBe(true)
      }
    })

    it('handles "aapko kya lagta hai", in either script', () => {
      // Missed in the original patterns and found live: a participant asked
      // "उरुशी, आपको क्या लगता है?" — the most natural way to put it — and was
      // refused on cooldown, because only the आप क्या कहते/सोचते shapes existed.
      for (const text of [
        'उरुशी, आपको क्या लगता है?',
        'Urushi, aapko kya lagta hai?',
        'उरुशी, आपका क्या कहना है?',
        'Urushi, aapko kya lagti hai baat?',
      ]) {
        expect(detectDirectAddress(text), text).toBe(true)
      }
    })

    it('recognises the name through its known mis-transcription', () => {
      // Observed live: "Urushi क्या बोल रहा है?" came back as "पुरुषों क्या बोल
      // रहा है?". Instructing the transcriber not to do this, by name, did not
      // hold — so the corruption is accepted as an address form here instead.
      expect(detectDirectAddress('पुरुषों, आप क्या कहते हैं?')).toBe(true)
      expect(detectDirectAddress('पुरुषों, कुछ बोलिए')).toBe(true)
    })

    it('still ignores genuine sentences about men', () => {
      // पुरुषों is an ordinary Hindi word. Requiring an invitation is what keeps
      // accepting it as an alias from turning every mention of men into a
      // summons.
      for (const text of [
        'पुरुषों ने नहीं.',
        'दोनों पुरुष यहाँ थे।',
        'पुरुषों की बात अलग है।',
      ]) {
        expect(detectDirectAddress(text), text).toBe(false)
      }
    })

    it('ignores Hindi questions asked of each other', () => {
      for (const text of [
        'आप क्या कहते हैं?',
        'आपकी क्या राय है?',
        'कुछ बोलिए ना',
        'मदद कीजिए',
        'aap kya sochte hain?',
      ]) {
        expect(detectDirectAddress(text), text).toBe(false)
      }
    })

    it('ignores Hindi talk about Urushi that is not an invitation', () => {
      for (const text of [
        'उरुशी चुप है।',
        'उरुशी रिकॉर्ड कर रही है।',
        'लेकिन आप तो कह रहे?',
      ]) {
        expect(detectDirectAddress(text), text).toBe(false)
      }
    })
  })
})
