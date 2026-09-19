import { describe, it, expect } from 'vitest'
import { buildFallbackOpening, buildOpeningInstruction, getReferenceOpening, type OpeningContext } from './openingPrompt'
import { normalizeConversationSettings, type ConversationSettings } from '@/lib/conversation/settings'

function ctx(
  settings: Partial<ConversationSettings> = {},
  overrides: Partial<Omit<OpeningContext, 'settings'>> = {}
): OpeningContext {
  return {
    settings: normalizeConversationSettings(settings),
    profanityAccepted: false,
    hasContext: false,
    ...overrides,
  }
}

const SHOOTER_STRONG = { personality: 'straight_shooter', allowProfanity: true, language: 'hinglish' } as const

describe('the strong opening waits for consent', () => {
  it('uses the strong opening only once everyone has accepted', () => {
    const accepted = getReferenceOpening(ctx(SHOOTER_STRONG, { profanityAccepted: true }))
    expect(accepted).toContain('chutiya banana')
  })

  it('falls back to clean language when the setting is on but unaccepted', () => {
    // The opening is the first thing anyone hears. Using the strong version on
    // the strength of a proposal nobody agreed to would be the worst possible
    // moment to get consent wrong.
    const pending = getReferenceOpening(ctx(SHOOTER_STRONG, { profanityAccepted: false }))
    expect(pending).not.toContain('chutiya')
    expect(pending).toContain('seedhi baat')
  })

  it('stays clean when profanity was never requested, however accepted', () => {
    const clean = getReferenceOpening(
      ctx({ personality: 'straight_shooter', language: 'hinglish' }, { profanityAccepted: true })
    )
    expect(clean).not.toContain('chutiya')
  })
})

describe('the opening sounds like the chosen personality', () => {
  it('opens the Straight Shooter bluntly, with no corporate welcome', () => {
    const opening = getReferenceOpening(ctx({ personality: 'straight_shooter', language: 'hinglish' }))
    expect(opening).toContain('seedhi baat')
    // A Straight Shooter introducing itself politely has already broken the
    // promise the participants chose it for.
    expect(opening).not.toMatch(/I'?ll mostly listen/i)
  })

  it('opens the Diplomat warmly', () => {
    expect(getReferenceOpening(ctx({ personality: 'diplomat', language: 'english' }))).toMatch(/mostly listen/i)
  })

  it('opens the Deal Maker on what each person needs', () => {
    expect(getReferenceOpening(ctx({ personality: 'deal_maker', language: 'english' }))).toMatch(/both live with/i)
  })
})

describe('language and script', () => {
  it('follows the chosen script', () => {
    const devanagari = getReferenceOpening(ctx({ personality: 'straight_shooter', language: 'hindi', textScript: 'devanagari' }))
    const roman = getReferenceOpening(ctx({ personality: 'straight_shooter', language: 'hindi', textScript: 'roman' }))
    expect(devanagari).toMatch(/[ऀ-ॿ]/)
    expect(roman).not.toMatch(/[ऀ-ॿ]/)
  })

  it('does not translate gaalis into awkward English', () => {
    // An English room gets English bluntness. Importing Hindi profanity into it
    // would sound absurd rather than direct.
    const english = getReferenceOpening(ctx({ ...SHOOTER_STRONG, language: 'english' }, { profanityAccepted: true }))
    expect(english).not.toContain('chutiya')
    expect(english).toContain('bullshitting')
  })
})

describe('safety overrides everything', () => {
  const concern = { safetyConcern: true, profanityAccepted: true }

  it('drops profanity and banter entirely', () => {
    const opening = getReferenceOpening(ctx(SHOOTER_STRONG, concern))
    expect(opening).not.toContain('chutiya')
    expect(opening).not.toContain('seedhi baat')
    expect(opening).toContain('koi jaldi nahi'.replace('koi', 'Koi'))
  })

  it('tells the model to drop the personality performance', () => {
    const instruction = buildOpeningInstruction(ctx(SHOOTER_STRONG, concern))
    expect(instruction).toContain('no banter')
    expect(instruction).toContain('no performance of personality')
  })
})

describe('buildOpeningInstruction', () => {
  it('asks a specific question when the dispute is already known', () => {
    // Asking people to repeat what they already wrote down is how you lose them
    // in the first minute.
    const instruction = buildOpeningInstruction(ctx(SHOOTER_STRONG, { hasContext: true }))
    expect(instruction).toContain('do NOT ask them to explain everything from scratch')
    expect(instruction).toContain('one specific, useful first question')
  })

  it('asks them to describe it when nothing is known yet', () => {
    const instruction = buildOpeningInstruction(ctx(SHOOTER_STRONG, { hasContext: false }))
    expect(instruction).toContain('Nobody has described the dispute yet')
  })

  it('forbids a corporate welcome and a personality monologue', () => {
    const instruction = buildOpeningInstruction(ctx(SHOOTER_STRONG))
    expect(instruction).toContain('Do NOT give a corporate welcome')
    expect(instruction).toContain('show it instead')
  })

  it('frames the opening as expectations rather than an accusation', () => {
    // "Stop misleading each other" must not read as a finding that someone
    // already has.
    const instruction = buildOpeningInstruction(ctx(SHOOTER_STRONG, { profanityAccepted: true }))
    expect(instruction).toContain('Setting expectations is not an accusation')
    expect(instruction).toContain('do not imply either person has already lied')
  })

  it('keeps it short', () => {
    expect(buildOpeningInstruction(ctx())).toContain('Two or three sentences, no more')
  })
})

describe('buildFallbackOpening', () => {
  const base = { participantNames: ['Manan', 'Sonam'], topic: 'how we split the work' }

  it('is a real speakable line naming the participants', () => {
    const line = buildFallbackOpening({ ...ctx(SHOOTER_STRONG, { profanityAccepted: true }), ...base })
    expect(line).toContain('Manan and Sonam')
    expect(line).toContain('seedhi baat')
  })

  it('respects consent in demo mode too', () => {
    const line = buildFallbackOpening({ ...ctx(SHOOTER_STRONG, { profanityAccepted: false }), ...base })
    expect(line).not.toContain('chutiya')
  })

  it('still greets when no participants are recorded', () => {
    const line = buildFallbackOpening({ ...ctx(), ...base, participantNames: [] })
    expect(line).toContain('everyone')
  })
})
