import { describe, it, expect } from 'vitest'
import { detectSpokenLanguage, detectRoomLanguage } from './languageDetection'

describe('detectSpokenLanguage', () => {
  it('detects Devanagari script as Hindi unambiguously', () => {
    expect(detectSpokenLanguage('हमें तेज़ फैसले लेने चाहिए')).toBe('hindi')
  })

  it('detects heavily romanized Hindi as Hindi', () => {
    expect(detectSpokenLanguage('Yaar dekho, hume faster decisions lene chahiye.')).toBe('hindi')
    expect(detectSpokenLanguage('Main sirf ye keh raha hoon ki hume kuch karna hoga.')).toBe('hindi')
  })

  it('detects a genuine Hindi/English mix as hinglish, not hindi', () => {
    // Mostly English content words with a light sprinkling of Hindi function words —
    // real Hinglish, not "hai" once at the end of an English sentence.
    expect(detectSpokenLanguage('So basically hum need karte hain ek better process for this whole approval workflow honestly.')).toBe('hinglish')
  })

  it('detects plain English as english', () => {
    expect(detectSpokenLanguage('We need to move faster on this decision.')).toBe('english')
  })

  it('treats empty or whitespace-only text as english (neutral default)', () => {
    expect(detectSpokenLanguage('')).toBe('english')
    expect(detectSpokenLanguage('   ')).toBe('english')
  })

  it('does not false-positive on English sentences that happen to contain short overlapping words', () => {
    // "to" is not in the marker list; sanity check ordinary English stays english.
    expect(detectSpokenLanguage('I want to go to the store to buy milk.')).toBe('english')
  })

  it('does not false-positive on English words that collide with romanized Hindi ("the", "are", "main", "par", "tab", "ya")', () => {
    expect(detectSpokenLanguage('Are you sure the main point is on par with what we said in the other tab?')).toBe('english')
    expect(detectSpokenLanguage("Ya, that's the main issue we're facing here.")).toBe('english')
  })
})

describe('detectRoomLanguage', () => {
  it('uses the latest utterance when it has enough words to be a reliable signal', () => {
    expect(detectRoomLanguage('Hume faster decisions lene chahiye abhi.', ['We should decide quickly.'])).toBe('hindi')
  })

  it('falls back to recent transcript when the latest utterance is too short to classify', () => {
    // "haan" alone is too short/ambiguous — look backward for real signal.
    expect(
      detectRoomLanguage('haan', [
        'We need to move faster on this.',
        'Yaar dekho, hume faster decisions lene chahiye.',
      ])
    ).toBe('hindi')
  })

  it('walks further back if the immediately preceding line is also too short', () => {
    expect(
      detectRoomLanguage('ok', [
        'Yaar dekho, hume faster decisions lene chahiye.',
        'haan',
      ])
    ).toBe('hindi')
  })

  it('returns english when nothing in the window has enough signal', () => {
    expect(detectRoomLanguage('ok', ['yes', 'sure'])).toBe('english')
  })

  it('returns english for an all-English conversation', () => {
    expect(
      detectRoomLanguage('Let us just decide on Friday.', ['We should move faster.', 'I disagree with that.'])
    ).toBe('english')
  })
})
