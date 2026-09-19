import { describe, it, expect } from 'vitest'
import { buildSpokenLanguageDirection, chooseSpokenLanguage } from './spokenLanguage'

describe('chooseSpokenLanguage', () => {
  it('picks Hinglish when Hindi is among the room languages', () => {
    expect(chooseSpokenLanguage(['en', 'hi'])).toBe('hinglish')
    expect(chooseSpokenLanguage(['hi'])).toBe('hinglish')
  })

  it('picks English otherwise', () => {
    expect(chooseSpokenLanguage(['en'])).toBe('english')
    expect(chooseSpokenLanguage([])).toBe('english')
  })
})

describe('buildSpokenLanguageDirection', () => {
  it('says nothing for an English room', () => {
    // The models already speak conversational English; guidance here is noise.
    expect(buildSpokenLanguageDirection(['en'])).toBe('')
    expect(buildSpokenLanguageDirection([])).toBe('')
  })

  it('names the exact formal words that came out live', () => {
    // Observed: "aap dono ke beech kaam ka vibhajan ek mahatvapurn vishay hai".
    // Correct Hindi, wrong register — naming the words is what moves the model,
    // because "speak naturally" is advice it believes it already follows.
    const direction = buildSpokenLanguageDirection(['en', 'hi'])
    for (const word of ['vibhajan', 'mahatvapurn', 'vichar vyakt karna']) {
      expect(direction, word).toContain(word)
    }
  })

  it('asks for Latin script, not Devanagari', () => {
    const direction = buildSpokenLanguageDirection(['en', 'hi'])
    expect(direction).toContain('Latin script')
    expect(direction).toContain('never Devanagari')
  })

  it('tells it to match the room rather than lead', () => {
    expect(buildSpokenLanguageDirection(['hi'])).toContain('Match the room')
  })
})
