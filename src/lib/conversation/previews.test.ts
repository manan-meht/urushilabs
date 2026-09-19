import { describe, it, expect } from 'vitest'
import { getPreviewScenario, getStylePreview } from './previews'
import {
  CONVERSATION_LANGUAGES,
  MEDIATOR_PERSONALITIES,
  TEXT_SCRIPTS,
  type ConversationLanguage,
  type TextScript,
} from './settings'

const DEVANAGARI = /[ऀ-ॿ]/

describe('previews follow the chosen script', () => {
  it('renders Hindi in Roman when Roman is selected', () => {
    // The bug this pins: previews keyed off language alone, so choosing Roman
    // script still showed Devanagari and the setting looked broken.
    const roman = getStylePreview('straight_shooter', 'hindi', 'roman', true)
    expect(roman).not.toMatch(DEVANAGARI)
    expect(roman.toLowerCase()).toContain('bakwaas')
  })

  it('renders Hindi in Devanagari when Devanagari is selected', () => {
    expect(getStylePreview('straight_shooter', 'hindi', 'devanagari', true)).toMatch(DEVANAGARI)
  })

  it('applies the script to the scenario as well as the reply', () => {
    // Showing the scenario in one script and the answer in another would look
    // like a rendering fault.
    expect(getPreviewScenario('hindi', 'roman')).not.toMatch(DEVANAGARI)
    expect(getPreviewScenario('hindi', 'devanagari')).toMatch(DEVANAGARI)
  })

  it('never renders English in Devanagari, whatever the script', () => {
    for (const script of TEXT_SCRIPTS) {
      expect(getStylePreview('diplomat', 'english', script), script).not.toMatch(DEVANAGARI)
      expect(getPreviewScenario('english', script), script).not.toMatch(DEVANAGARI)
    }
  })

  it('has a non-empty preview for every combination', () => {
    // 3 personalities x 3 languages x 2 scripts, plus the profane variant — a
    // missing cell would render an empty quote rather than throw.
    for (const personality of MEDIATOR_PERSONALITIES) {
      for (const language of CONVERSATION_LANGUAGES) {
        for (const script of TEXT_SCRIPTS) {
          for (const profanity of [false, true]) {
            const label = `${personality}/${language}/${script}/${profanity}`
            expect(getStylePreview(personality, language, script, profanity), label).toBeTruthy()
            expect(getPreviewScenario(language, script), label).toBeTruthy()
          }
        }
      }
    }
  })
})

describe('preview content', () => {
  it('only swears when profanity is on, and only for the Straight Shooter', () => {
    expect(getStylePreview('straight_shooter', 'english', 'roman', true)).toContain('bullshit')
    expect(getStylePreview('straight_shooter', 'english', 'roman', false)).not.toContain('bullshit')
    // Forced off upstream for the others; passing true here must be ignored.
    for (const personality of ['diplomat', 'deal_maker'] as const) {
      expect(getStylePreview(personality, 'english', 'roman', true), personality).not.toContain('bullshit')
    }
  })

  it('gives each personality a visibly different answer to the same scenario', () => {
    // The whole point of the picker: same input, three distinguishable replies.
    const [a, b, c] = MEDIATOR_PERSONALITIES.map((p) => getStylePreview(p, 'english', 'roman'))
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('keeps Hinglish code-mixed rather than translating work words', () => {
    // A literal translation would produce the stiff register the language module
    // exists to prevent.
    const hinglish = getStylePreview('deal_maker', 'hinglish', 'roman')
    expect(hinglish).toContain('deadline')
  })
})

describe('language and script are independent choices', () => {
  it('distinguishes Hindi-in-Roman from Hinglish', () => {
    // Romanised Hindi is not the same thing as Hinglish: one is a script choice,
    // the other is how much English is mixed in.
    const combos: Array<[ConversationLanguage, TextScript]> = [['hindi', 'roman'], ['hinglish', 'roman']]
    const [hindiRoman, hinglish] = combos.map(([l, s]) => getStylePreview('diplomat', l, s))
    expect(hindiRoman).not.toBe(hinglish)
  })
})
