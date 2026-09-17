import { describe, it, expect } from 'vitest'
import { nextIssueStatus, affirmAgreement, createAgreementState } from './roomState'

describe('nextIssueStatus', () => {
  it('moves pending -> discussing on start_discussing', () => {
    expect(nextIssueStatus('pending', 'start_discussing')).toBe('discussing')
  })

  it('moves discussing -> agreed on mark_agreed', () => {
    expect(nextIssueStatus('discussing', 'mark_agreed')).toBe('agreed')
  })

  it('moves discussing -> unresolved on mark_unresolved', () => {
    expect(nextIssueStatus('discussing', 'mark_unresolved')).toBe('unresolved')
  })

  it('ignores events that do not apply to the current status', () => {
    expect(nextIssueStatus('agreed', 'mark_unresolved')).toBe('agreed')
  })

  it('allows reopening an unresolved issue', () => {
    expect(nextIssueStatus('unresolved', 'start_discussing')).toBe('discussing')
  })
})

describe('createAgreementState', () => {
  it('starts with nobody agreed and everybody awaiting', () => {
    const state = createAgreementState(['p1', 'p2', 'p3'])
    expect(state.agreedBy).toEqual([])
    expect(state.awaiting).toEqual(['p1', 'p2', 'p3'])
  })
})

describe('affirmAgreement', () => {
  it('is not confirmed until every participant has affirmed', () => {
    let state = createAgreementState(['p1', 'p2'])
    const afterP1 = affirmAgreement(state, 'p1')
    expect(afterP1.confirmed).toBe(false)
    expect(afterP1.agreedBy).toEqual(['p1'])
    expect(afterP1.awaiting).toEqual(['p2'])

    state = afterP1
    const afterP2 = affirmAgreement(state, 'p2')
    expect(afterP2.confirmed).toBe(true)
    expect(afterP2.awaiting).toEqual([])
  })

  it('does not double-count the same participant affirming twice', () => {
    const state = createAgreementState(['p1', 'p2'])
    const once = affirmAgreement(state, 'p1')
    const twice = affirmAgreement(once, 'p1')
    expect(twice.agreedBy).toEqual(['p1'])
    expect(twice.confirmed).toBe(false)
  })

  it('never confirms from an affirmation by someone not in the awaiting list alone', () => {
    // A 3-person agreement: p3's affirmation alone should not confirm it.
    const state = createAgreementState(['p1', 'p2', 'p3'])
    const result = affirmAgreement(state, 'p3')
    expect(result.confirmed).toBe(false)
    expect(result.awaiting).toEqual(['p1', 'p2'])
  })
})
