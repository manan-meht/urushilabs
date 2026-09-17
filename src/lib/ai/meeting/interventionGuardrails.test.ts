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
})

describe('detectEscalationSignal — realistic meeting transcript fixtures', () => {
  it('does NOT flag productive back-and-forth disagreement (spec §42 fixture)', () => {
    const lines = [
      "I feel like I'm doing most of the work.",
      'You send me ten things at once and call everything urgent.',
      'Because otherwise decisions take forever.',
      'I need time to actually think before answering.',
    ]
    for (const line of lines) {
      expect(detectEscalationSignal(line)).toBe(false)
    }
  })

  it('flags character attacks / contempt', () => {
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
    expect(enforceCooldown({ proposedAction: 'CLARIFY', secondsSinceLastIntervention: 3 })).toBe('LISTEN')
  })

  it('allows a spoken action once the cooldown has elapsed', () => {
    expect(enforceCooldown({ proposedAction: 'CLARIFY', secondsSinceLastIntervention: DEFAULT_COOLDOWN_SECONDS + 1 })).toBe('CLARIFY')
  })

  it('lets DEESCALATE and END_SESSION bypass the cooldown', () => {
    expect(enforceCooldown({ proposedAction: 'DEESCALATE', secondsSinceLastIntervention: 1 })).toBe('DEESCALATE')
    expect(enforceCooldown({ proposedAction: 'END_SESSION', secondsSinceLastIntervention: 1 })).toBe('END_SESSION')
  })
})
