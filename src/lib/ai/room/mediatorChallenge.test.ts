import { describe, it, expect } from 'vitest'
import { detectMediatorChallenge, detectVerdictRequest } from './mediatorChallenge'

describe('detectMediatorChallenge', () => {
  it('catches complaints about one-sidedness', () => {
    for (const text of [
      'मुझे लगता है कि तुम मेरे दिमाग की दही कर रहे हो और सोनम को कुछ भी नहीं बोल रहे.',
      "You're not saying anything to Sonam.",
      'Tum kuch bol hi nahi rahe.',
    ]) {
      expect(detectMediatorChallenge(text), text).toBe(true)
    }
  })

  it('catches complaints about repeating itself', () => {
    // A participant noticed two near-identical turns before the system did.
    for (const text of [
      'ये आप दो बार बोल चुके हो, इससे ज़्यादा मैं और कुछ नहीं बोल सकता.',
      'Aap do baar bol chuke ho.',
      'You said that twice already.',
    ]) {
      expect(detectMediatorChallenge(text), text).toBe(true)
    }
  })

  it('catches complaints about not helping', () => {
    for (const text of [
      'नहीं यही issues हैं और उसमें आप मुझे कोई solution नहीं दे रहे.',
      "You're not giving me any solution.",
      "That's not helping.",
    ]) {
      expect(detectMediatorChallenge(text), text).toBe(true)
    }
  })

  it('does not fire on complaints about the OTHER participant', () => {
    // The distinction that matters: Urushi should engage when criticised, not
    // when it overhears one person criticising the other.
    for (const text of [
      'सोनम कुछ नहीं करती, पूरा दिन टीवी देखती है।',
      'He never listens to what I actually said.',
      'Tum mujhe kabhi seriously nahi lete.',
      'मुझे लगता है कि सारा काम मैं करता हूँ।',
    ]) {
      expect(detectMediatorChallenge(text), text).toBe(false)
    }
  })

  it('does not fire on ordinary conversation', () => {
    for (const text of [
      'Friday ko payment ka promise tha.',
      'मुझे थोड़ा टाइम चाहिए सोचने के लिए।',
      'Theek hai, chalo aage badhte hain.',
    ]) {
      expect(detectMediatorChallenge(text), text).toBe(false)
    }
  })

  it('handles empty input', () => {
    expect(detectMediatorChallenge('')).toBe(false)
  })
})

describe('detectVerdictRequest', () => {
  it('catches requests for a verdict in both languages', () => {
    for (const text of [
      'उरुशी किसका पॉइंट सही है?',
      'आपकी राय क्या है?',
      'Toh galti kiski hai?',
      'Kaun sahi hai?',
      'Who is right here?',
      'Whose argument holds up?',
    ]) {
      expect(detectVerdictRequest(text), text).toBe(true)
    }
  })

  it('does not fire on ordinary questions', () => {
    for (const text of [
      'Friday ko kya hua tha?',
      'What time is the meeting?',
      'तुमने उसे बताया था क्या?',
    ]) {
      expect(detectVerdictRequest(text), text).toBe(false)
    }
  })
})
