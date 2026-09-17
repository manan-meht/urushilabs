import { describe, it, expect } from 'vitest'
import { nextIssueStatus, affirmAgreement, createAgreementState } from './meetingState'

describe('nextIssueStatus', () => {
  it('moves pending -> discussing -> agreed', () => {
    expect(nextIssueStatus('pending', 'start_discussing')).toBe('discussing')
    expect(nextIssueStatus('discussing', 'mark_agreed')).toBe('agreed')
  })

  it('ignores events that do not apply to the current state', () => {
    expect(nextIssueStatus('agreed', 'mark_unresolved')).toBe('agreed')
  })

  it('allows reopening a partial or unresolved issue', () => {
    expect(nextIssueStatus('partial', 'start_discussing')).toBe('discussing')
    expect(nextIssueStatus('unresolved', 'start_discussing')).toBe('discussing')
  })
})

describe('affirmAgreement — never inferred from silence (spec §25)', () => {
  it('is not confirmed until every awaited participant affirms', () => {
    const state = createAgreementState(['p1', 'p2'])
    const afterP1 = affirmAgreement(state, 'p1')
    expect(afterP1.confirmed).toBe(false)
    expect(afterP1.agreedBy).toEqual(['p1'])
    expect(afterP1.awaiting).toEqual(['p2'])

    const afterP2 = affirmAgreement(afterP1, 'p2')
    expect(afterP2.confirmed).toBe(true)
    expect(afterP2.awaiting).toEqual([])
  })

  it('is idempotent — affirming twice does not duplicate', () => {
    const state = createAgreementState(['p1', 'p2'])
    const once = affirmAgreement(state, 'p1')
    const twice = affirmAgreement(once, 'p1')
    expect(twice.agreedBy).toEqual(['p1'])
  })

  it('a single-participant agreement confirms immediately upon that participant affirming', () => {
    const state = createAgreementState(['p1'])
    const result = affirmAgreement(state, 'p1')
    expect(result.confirmed).toBe(true)
  })
})
