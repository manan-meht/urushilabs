import { describe, it, expect } from 'vitest'
import { findMatchingIssue, issueSimilarity, issueTokens } from './issueMatching'

const existing = [{ id: 'i1', title: 'Workload and Decision-Making' }]

describe('findMatchingIssue', () => {
  it('matches the title that actually shipped a duplicate', () => {
    // Observed in a replay: these two were filed as separate issues, so one
    // argument appeared in the report as two unresolved problems. Neither is a
    // substring of the other, which is why the original check missed it.
    expect(findMatchingIssue('Workload, Decision-Making, and Time Management', existing)?.id).toBe('i1')
  })

  it('still matches the easy cases', () => {
    expect(findMatchingIssue('workload and decision-making', existing)?.id).toBe('i1')
    expect(findMatchingIssue('Workload', existing)?.id).toBe('i1')
    expect(findMatchingIssue('Ongoing Workload and Decision-Making dispute', existing)?.id).toBe('i1')
  })

  it('does not merge a genuinely different dispute', () => {
    // Merging everything would be an easy way to pass the test above and would
    // hide real second issues from the report.
    expect(findMatchingIssue('Who pays for the office lease', existing)).toBeNull()
    expect(findMatchingIssue('Holiday scheduling', existing)).toBeNull()
  })

  it('returns null for an empty or meaningless title', () => {
    expect(findMatchingIssue('', existing)).toBeNull()
    expect(findMatchingIssue('   ', existing)).toBeNull()
    expect(findMatchingIssue('the issue', existing)).toBeNull()
  })

  it('handles an empty issue list', () => {
    expect(findMatchingIssue('Workload', [])).toBeNull()
  })

  it('picks the closest of several candidates', () => {
    const many = [
      { id: 'a', title: 'Office lease costs' },
      { id: 'b', title: 'Workload and Decision-Making' },
      { id: 'c', title: 'Holiday scheduling' },
    ]
    expect(findMatchingIssue('Workload, Decision-Making and Time', many)?.id).toBe('b')
  })
})

describe('issueTokens', () => {
  it('drops punctuation, casing and filler words', () => {
    expect([...issueTokens('Workload, Decision-Making, and Time Management')])
      .toEqual(['workload', 'decision', 'making', 'time', 'management'])
  })

  it('drops Hindi connectives so Hinglish titles compare on their nouns', () => {
    expect(issueTokens('Kaam ka distribution ka issue').has('distribution')).toBe(true)
    expect(issueTokens('Kaam ka distribution ka issue').has('issue')).toBe(false)
  })
})

describe('issueSimilarity', () => {
  it('scores against the shorter title, so a subset is a full match', () => {
    // Union-based scoring called this 0.25 and filed a duplicate.
    expect(issueSimilarity('workload', 'workload decision making time management')).toBe(1)
  })

  it('scores unrelated titles at zero', () => {
    expect(issueSimilarity('office lease', 'holiday scheduling')).toBe(0)
  })
})
