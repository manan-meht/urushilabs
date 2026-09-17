import { describe, it, expect } from 'vitest'
import { isTrivialUtterance, detectEscalationSignal, enforceCooldown, DEFAULT_COOLDOWN_SECONDS } from './interventionGuardrails'

describe('isTrivialUtterance', () => {
  it('treats bare acknowledgements as trivial', () => {
    for (const text of ['yes', 'No.', 'right', 'okay', 'exactly!', 'mmhmm']) {
      expect(isTrivialUtterance(text)).toBe(true)
    }
  })

  it('does not treat substantive short statements as trivial', () => {
    expect(isTrivialUtterance("I don't agree with that.")).toBe(false)
  })

  it('treats empty input as trivial', () => {
    expect(isTrivialUtterance('   ')).toBe(true)
  })

  it('does not treat longer explanations as trivial even if they start with yes', () => {
    expect(isTrivialUtterance('Yes but that is not the whole story here')).toBe(false)
  })
})

describe('detectEscalationSignal — realistic conversation fixtures', () => {
  it('does NOT flag productive back-and-forth disagreement (spec fixture 1)', () => {
    const lines = [
      "I feel like I'm carrying most of the work.",
      "I don't agree. You're assigning things constantly and expecting immediate replies.",
      'Because otherwise decisions sit there for days.',
      "That's because everything is marked urgent.",
    ]
    for (const line of lines) {
      expect(detectEscalationSignal(line)).toBe(false)
    }
  })

  it('flags character attacks / contempt (spec fixture 2)', () => {
    expect(detectEscalationSignal("You're just impossible to work with.")).toBe(true)
    expect(detectEscalationSignal('And you never listen to anyone.')).toBe(true)
  })

  it('does not flag ordinary blunt criticism', () => {
    expect(detectEscalationSignal('I think that decision was a mistake.')).toBe(false)
  })
})

describe('enforceCooldown', () => {
  it('always allows LISTEN through', () => {
    expect(enforceCooldown({ proposedAction: 'LISTEN', secondsSinceLastIntervention: 0 })).toBe('LISTEN')
  })

  it('downgrades a spoken action to LISTEN when within the cooldown window', () => {
    const result = enforceCooldown({ proposedAction: 'CLARIFY', secondsSinceLastIntervention: 3 })
    expect(result).toBe('LISTEN')
  })

  it('allows a spoken action once the cooldown has elapsed', () => {
    const result = enforceCooldown({ proposedAction: 'CLARIFY', secondsSinceLastIntervention: DEFAULT_COOLDOWN_SECONDS + 1 })
    expect(result).toBe('CLARIFY')
  })

  it('lets DEESCALATE bypass the cooldown', () => {
    const result = enforceCooldown({ proposedAction: 'DEESCALATE', secondsSinceLastIntervention: 1 })
    expect(result).toBe('DEESCALATE')
  })

  it('lets END_SESSION bypass the cooldown', () => {
    const result = enforceCooldown({ proposedAction: 'END_SESSION', secondsSinceLastIntervention: 1 })
    expect(result).toBe('END_SESSION')
  })

  it('respects a custom cooldown window', () => {
    expect(enforceCooldown({ proposedAction: 'SUMMARIZE', secondsSinceLastIntervention: 5, cooldownSeconds: 3 })).toBe('SUMMARIZE')
  })
})
