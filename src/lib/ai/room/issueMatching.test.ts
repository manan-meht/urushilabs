import { describe, it, expect } from 'vitest'
import { decideIssueOutcome, findMatchingIssue, issueSimilarity, issueTokens } from './issueMatching'

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

describe('decideIssueOutcome', () => {
  const open = [{ id: 'i1', title: 'Workload and Decision-Making' }]

  it('records an issue named on an action that is not IDENTIFY_ISSUE', () => {
    // The bug: currentIssueTitle is returned on every decision, and only
    // IDENTIFY_ISSUE ever acted on it. Across 16 replays a session had an issue
    // row if and only if the model happened to pick that one action, and 7 of 16
    // ended with no issue at all despite a clearly identified dispute — one
    // returned "Missed deadline and agreement on date" on a CLARIFY and recorded
    // nothing.
    expect(decideIssueOutcome({ action: 'CLARIFY', title: 'Missed deadline', existing: [] }))
      .toEqual({ kind: 'create' })
    expect(decideIssueOutcome({ action: 'GIVE_VERDICT', title: 'Missed deadline', existing: [] }))
      .toEqual({ kind: 'create' })
  })

  it('attaches to the open issue from any spoken action', () => {
    // These two score exactly 1/3 — a real pair this system produced. The
    // threshold sat at 0.34 and missed it by seven thousandths.
    expect(decideIssueOutcome({
      action: 'GIVE_VERDICT', title: 'Workload and Time Management',
      existing: open, currentIssueId: 'i1',
    })).toEqual({ kind: 'reuse', id: 'i1' })
  })

  it('will not open a SECOND issue from an incidental label', () => {
    // Creating stays narrower than recognising. A passing label on a verdict is
    // not a new dispute, and treating it as one re-creates the duplicate rows
    // this module exists to prevent.
    expect(decideIssueOutcome({
      action: 'PROPOSE_COMPROMISE', title: 'Preventing future miscommunication',
      existing: open, currentIssueId: 'i1',
    })).toEqual({ kind: 'none' })
  })

  it('lets IDENTIFY_ISSUE open a second issue, because that is it saying so', () => {
    expect(decideIssueOutcome({
      action: 'IDENTIFY_ISSUE', title: 'Who pays for the office lease',
      existing: open, currentIssueId: 'i1',
    })).toEqual({ kind: 'create' })
  })

  it('does not open a new row once the room has moved on from an issue', () => {
    // MOVE_TO_NEXT_ISSUE sets current_issue_id to NULL, so "nothing is open" is
    // true again every time the room moves on. Gating creation on that let any
    // passing label file another row, and one replay produced three rows for a
    // single dispute.
    expect(decideIssueOutcome({
      action: 'GIVE_VERDICT', title: 'Something else entirely',
      existing: open, currentIssueId: null,
    })).toEqual({ kind: 'none' })
  })

  it('still recognises a rename after the room moved on', () => {
    expect(decideIssueOutcome({
      action: 'GIVE_VERDICT', title: 'Workload and Time Management',
      existing: open, currentIssueId: null,
    })).toEqual({ kind: 'reuse', id: 'i1' })
  })

  it('does not file the opening phase as the room\'s dispute', () => {
    // From the first live session after issue-capture was widened: during the
    // opening a CLARIFY returned "Mediation not started yet" as its issue title,
    // and it was recorded as the dispute — in the artefact participants keep.
    expect(decideIssueOutcome({
      action: 'CLARIFY', title: 'Mediation not started yet',
      existing: [], mediationStarted: false,
    })).toEqual({ kind: 'none' })
  })

  it('still lets IDENTIFY_ISSUE name an issue during the opening', () => {
    // That action is the model explicitly saying "this is the issue", which is
    // different from it labelling the moment.
    expect(decideIssueOutcome({
      action: 'IDENTIFY_ISSUE', title: 'Workload split',
      existing: [], mediationStarted: false,
    })).toEqual({ kind: 'create' })
  })

  it('captures an issue named on any action once mediation is under way', () => {
    expect(decideIssueOutcome({
      action: 'GIVE_VERDICT', title: 'Missed deadline',
      existing: [], mediationStarted: true,
    })).toEqual({ kind: 'create' })
  })

  it('ignores LISTEN and empty titles', () => {
    expect(decideIssueOutcome({ action: 'LISTEN', title: 'Workload', existing: open }))
      .toEqual({ kind: 'none' })
    expect(decideIssueOutcome({ action: 'CLARIFY', existing: open })).toEqual({ kind: 'none' })
    expect(decideIssueOutcome({ action: 'CLARIFY', title: '   ', existing: open }))
      .toEqual({ kind: 'none' })
  })
})
