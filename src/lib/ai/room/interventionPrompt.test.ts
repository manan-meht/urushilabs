import { describe, it, expect } from 'vitest'
import { buildInterventionPrompt } from './interventionPrompt'
import type { MediationContext } from './mediationController'

const baseCtx: MediationContext = {
  topic: 'Division of responsibilities',
  participantNames: ['Manan', 'Sonam'],
  recentTranscript: [
    { speakerName: 'Manan', content: "I feel like I'm carrying most of the work." },
    { speakerName: 'Sonam', content: "I don't agree. You're assigning things constantly." },
  ],
  latestUtterance: { speakerName: 'Manan', content: 'Because otherwise decisions sit there for days.' },
  secondsSinceLastIntervention: 999,
}

describe('buildInterventionPrompt', () => {
  it('lists all participant names and all 11 actions', () => {
    const { system } = buildInterventionPrompt(baseCtx)
    expect(system).toContain('Manan')
    expect(system).toContain('Sonam')
    for (const action of ['LISTEN', 'CLARIFY', 'INVITE_PARTICIPANT', 'REFRAME', 'DEESCALATE', 'IDENTIFY_ISSUE', 'SUMMARIZE', 'PROPOSE_COMPROMISE', 'CONFIRM_AGREEMENT', 'MOVE_TO_NEXT_ISSUE', 'END_SESSION']) {
      expect(system).toContain(action)
    }
  })

  it('instructs the controller that LISTEN is the default', () => {
    const { system } = buildInterventionPrompt(baseCtx)
    expect(system).toMatch(/When in doubt, choose LISTEN/i)
  })

  it('includes the topic, transcript, and latest utterance in the user message', () => {
    const { user } = buildInterventionPrompt(baseCtx)
    expect(user).toContain('Division of responsibilities')
    expect(user).toContain("carrying most of the work")
    expect(user).toContain('Because otherwise decisions sit there for days.')
  })

  it('includes the current issue when known', () => {
    const { user } = buildInterventionPrompt({ ...baseCtx, currentIssueTitle: 'Workload split' })
    expect(user).toContain('Workload split')
  })

  it('includes background context when provided', () => {
    const { user } = buildInterventionPrompt({ ...baseCtx, contextSummary: 'They run a business together.' })
    expect(user).toContain('They run a business together.')
  })
})
