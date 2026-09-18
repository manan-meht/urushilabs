import { describe, it, expect } from 'vitest'
import {
  buildFallbackOpening,
  buildOpeningInstruction,
  chooseOpeningLanguage,
} from './openingPrompt'

describe('chooseOpeningLanguage', () => {
  it('opens in Hinglish when the room is transcribed for Hindi', () => {
    expect(chooseOpeningLanguage(['en', 'hi'])).toBe('hinglish')
    expect(chooseOpeningLanguage(['hi'])).toBe('hinglish')
  })

  it('opens in English otherwise', () => {
    expect(chooseOpeningLanguage(['en'])).toBe('english')
    // Unconfigured rooms must not silently start speaking Hindi.
    expect(chooseOpeningLanguage([])).toBe('english')
  })
})

describe('buildOpeningInstruction', () => {
  it('always asks for names, the topic and an invitation to start', () => {
    for (const languages of [[], ['en'], ['en', 'hi']]) {
      const instruction = buildOpeningInstruction(languages)
      expect(instruction, JSON.stringify(languages)).toContain('greet them by name')
      expect(instruction).toContain('name the topic')
      expect(instruction).toContain('ONLY the words you will say out loud')
    }
  })

  it('asks for Latin-script Hinglish for a Hindi room', () => {
    const instruction = buildOpeningInstruction(['en', 'hi'])
    expect(instruction).toContain('Hinglish')
    // Devanagari would reintroduce the transcription confusion that turns the
    // name "Urushi" into पुरुषों — see directAddress.ts.
    expect(instruction).toContain('not Devanagari')
  })

  it('does not mention Hinglish for an English-only room', () => {
    const instruction = buildOpeningInstruction(['en'])
    expect(instruction).toContain('Speak in English')
    expect(instruction).not.toContain('Hinglish')
  })
})

describe('buildFallbackOpening', () => {
  const base = { participantNames: ['Manan', 'Bonam'], topic: 'how we make business decisions' }

  it('is a real speakable line, not a placeholder', () => {
    const line = buildFallbackOpening({ ...base, languageCodes: ['en'] })
    expect(line).toContain('Manan and Bonam')
    expect(line).toContain('how we make business decisions')
    expect(line).toContain('Urushi')
  })

  it('matches the room language', () => {
    const hinglish = buildFallbackOpening({ ...base, languageCodes: ['en', 'hi'] })
    expect(hinglish).toContain('Main Urushi hun')
    expect(hinglish).toContain('Manan and Bonam')
  })

  it('still greets when no participants are recorded yet', () => {
    const line = buildFallbackOpening({ ...base, participantNames: [], languageCodes: ['en'] })
    expect(line).toContain('everyone')
    expect(line).not.toContain('Hello .')
  })
})
