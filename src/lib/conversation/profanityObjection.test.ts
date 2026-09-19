import { describe, it, expect } from 'vitest'
import { detectProfanityObjection } from './profanityObjection'

describe('detectProfanityObjection', () => {
  it('catches direct requests to stop', () => {
    for (const text of [
      'Can you stop swearing please',
      'Please don’t swear.',
      'No more profanity, thanks.',
      'Watch your language.',
      'Turn off the swearing.',
      'Enough with the bad language.',
    ]) {
      expect(detectProfanityObjection(text), text).toBe(true)
    }
  })

  it('catches discomfort expressed indirectly', () => {
    for (const text of [
      'That language isn’t helping.',
      'The swearing is too much.',
      'Please keep it civil.',
      'I’m not comfortable with that language.',
    ]) {
      expect(detectProfanityObjection(text), text).toBe(true)
    }
  })

  it('catches Hindi and Hinglish objections', () => {
    for (const text of [
      'गाली मत दो',
      'तमीज़ से बात करो',
      'Gaali mat do yaar',
      'Tameez se baat karo',
    ]) {
      expect(detectProfanityObjection(text), text).toBe(true)
    }
  })

  it('does not fire on ordinary conversation', () => {
    // A false positive merely turns swearing off for a room that would have
    // tolerated it, so this list is about avoiding obvious nuisance rather than
    // being maximally strict.
    for (const text of [
      'I think we should talk about the deadline.',
      'He said he would finish it on Friday.',
      'मुझे लगता है कि काम बाँट लेना चाहिए।',
      'That was a difficult conversation.',
      'You agreed to it and then changed your mind.',
    ]) {
      expect(detectProfanityObjection(text), text).toBe(false)
    }
  })

  it('does not fire merely because a participant swore', () => {
    // Someone swearing is not someone asking Urushi to stop. Conflating the two
    // would disable the setting the moment the room got heated, which is often
    // exactly when it was wanted.
    for (const text of [
      'This whole thing is bullshit.',
      'Yaar ye to bakwaas hai.',
      'I’m fucking tired of this argument.',
    ]) {
      expect(detectProfanityObjection(text), text).toBe(false)
    }
  })

  it('handles empty input', () => {
    expect(detectProfanityObjection('')).toBe(false)
    expect(detectProfanityObjection('   ')).toBe(false)
  })
})
