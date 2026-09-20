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

describe('speaker attribution', () => {
  it('warns the model when it cannot tell the speakers apart', () => {
    // Observed live: with no diarization every turn reads "Unknown speaker", and
    // the model filled the gap by assuming everyone present had spoken — telling
    // a participant "after hearing both your views" when only one had.
    const { user } = buildInterventionPrompt({ ...baseCtx, speakersIdentified: false })
    expect(user).toContain('cannot tell the speakers apart')
    expect(user).toContain('after hearing both your views')
    expect(user).toContain('Do not assume everyone present has spoken')
  })

  it('says nothing about attribution when speakers are identified', () => {
    // A calibrated session knows who said what; hedging there would be worse.
    const { user } = buildInterventionPrompt({ ...baseCtx, speakersIdentified: true })
    expect(user).not.toContain('cannot tell the speakers apart')
  })

  it('stays silent when the caller has not said either way', () => {
    const { user } = buildInterventionPrompt(baseCtx)
    expect(user).not.toContain('cannot tell the speakers apart')
  })
})

describe('turn-taking', () => {
  it('tells Urushi the floor is its own after a reply and a pause', () => {
    // People hand over the floor by answering and then stopping. Urushi had no
    // model of this, so a participant would finish, wait, and get silence.
    const { user } = buildInterventionPrompt({ ...baseCtx, floorIsUrushis: true, silenceSeconds: 7 })
    expect(user).toContain('gone quiet for 7 seconds')
    expect(user).toContain('that is your turn')
    expect(user).toContain('they are waiting for you')
  })

  it('does not treat every pause as an invitation to speak', () => {
    // A lull that is not a reply to Urushi is just a lull.
    const { user } = buildInterventionPrompt({ ...baseCtx, floorIsUrushis: false, silenceSeconds: 9 })
    expect(user).toContain('not a reply to you')
    expect(user).toContain('A pause is not by itself a reason to speak')
  })

  it('says nothing about pauses when someone just spoke', () => {
    const { user } = buildInterventionPrompt(baseCtx)
    expect(user).not.toContain('gone quiet')
  })
})

describe('not repeating itself', () => {
  it('names what it has already said', () => {
    const { user } = buildInterventionPrompt({ ...baseCtx, recentSpokenActions: ['CLARIFY', 'INVITE_PARTICIPANT'] })
    expect(user).toContain('Your last spoken turns were: CLARIFY, INVITE_PARTICIPANT')
  })

  it('forbids a third request to clarify', () => {
    // Observed live: asked a room to confirm the same two issues after they had
    // confirmed them several times. Telling the model to read its own turns out
    // of the transcript did not stop it; handing it the list removes the
    // inference.
    const { user } = buildInterventionPrompt({ ...baseCtx, recentSpokenActions: ['CLARIFY', 'IDENTIFY_ISSUE'] })
    expect(user).toContain('Do NOT ask again')
    expect(user).toContain('reads as stalling')
  })

  it('does not scold after a single ask', () => {
    const { user } = buildInterventionPrompt({ ...baseCtx, recentSpokenActions: ['CLARIFY'] })
    expect(user).toContain('Your last spoken turns were: CLARIFY')
    expect(user).not.toContain('Do NOT ask again')
  })
})

describe('not repeating itself — expanded', () => {
  it('quotes its own last words back to itself', () => {
    // Action types alone missed two near-identical DEESCALATEs; a participant
    // caught it before the system did.
    const { user } = buildInterventionPrompt({
      ...baseCtx,
      recentSpokenActions: ['DEESCALATE', 'DEESCALATE'],
      lastSpokenText: 'Chalo thoda break lete hain.',
    })
    expect(user).toContain('Your last words were: "Chalo thoda break lete hain."')
    expect(user).toContain('do not say that again in different words')
  })

  it('flags the same action twice in a row, whatever the action', () => {
    const { user } = buildInterventionPrompt({ ...baseCtx, recentSpokenActions: ['DEESCALATE', 'DEESCALATE'] })
    expect(user).toContain('just done DEESCALATE twice in a row')
  })

  it('forbids re-confirming an issue that is already settled', () => {
    // The most frequent complaint from real sessions, and no count of action
    // types catches it — the existence of a tracked issue does.
    const { user } = buildInterventionPrompt({ ...baseCtx, currentIssueTitle: 'Workload distribution' })
    expect(user).toContain('"Workload distribution" is already settled')
    expect(user).toContain('Do NOT ask them to confirm')
  })

  it('says nothing about settled issues before one exists', () => {
    const { user } = buildInterventionPrompt({ ...baseCtx, currentIssueTitle: undefined })
    expect(user).not.toContain('already settled')
  })
})

describe('challenges aimed at Urushi', () => {
  it('requires engagement rather than de-escalation', () => {
    // Observed live: "you're not saying anything to Sonam" got a generic
    // "let's take a break", which is evasion dressed as care.
    const { system } = buildInterventionPrompt(baseCtx)
    expect(system).toContain('When someone challenges YOU')
    expect(system).toContain('Do not respond with a de-escalation')
    expect(system).toContain('Being asked to do your job is not a sign of escalating conflict')
  })
})
