import { describe, it, expect } from 'vitest'
import { buildInterventionPrompt } from './interventionPrompt'
import type { MediationContext } from './mediationController'
import { normalizeConversationSettings } from '@/lib/conversation/settings'

const baseCtx: MediationContext = {
  settings: normalizeConversationSettings({}),
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
      recentSpokenTexts: ['Chalo thoda break lete hain.'],
    })
    expect(user).toContain('You recently said: "Chalo thoda break lete hain."')
    expect(user).toContain('reuse their closing line')
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

describe('the agreed settings actually reach the prompt', () => {
  // The whole personality/language/profanity feature was built, unit-tested and
  // wired into the opening and the reports — and never reached this prompt, so
  // it governed the first sentence of a session and the report afterwards while
  // every intervention in between came out of the controller rules alone. A room
  // that chose the Straight Shooter was mediated by the Diplomat and nothing
  // anywhere failed. These tests exist so that cannot happen silently again.

  function ctx(overrides: Partial<Parameters<typeof normalizeConversationSettings>[0]>): MediationContext {
    return { ...baseCtx, settings: normalizeConversationSettings(overrides) }
  }

  it('carries the chosen personality into the system prompt', () => {
    expect(buildInterventionPrompt(ctx({ personality: 'straight_shooter' })).system)
      .toContain('The Straight Shooter')
    expect(buildInterventionPrompt(ctx({ personality: 'deal_maker' })).system)
      .toContain('The Deal Maker')
  })

  it('distinguishes the personalities rather than shipping one prompt for all three', () => {
    const shooter = buildInterventionPrompt(ctx({ personality: 'straight_shooter' })).system
    const diplomat = buildInterventionPrompt(ctx({ personality: 'diplomat' })).system
    expect(shooter).not.toBe(diplomat)
    // The judge-early instruction is the Straight Shooter's entire proposition.
    expect(shooter).toContain('Judge early')
    expect(diplomat).not.toContain('Judge early')
  })

  it('carries the chosen language, not the language of the transcript', () => {
    expect(buildInterventionPrompt(ctx({ language: 'hinglish' })).system).toContain('Language: Hinglish')
    expect(buildInterventionPrompt(ctx({ language: 'english' })).system).toContain('Language: English')
  })

  it('reminds the model of the language in final position, English included', () => {
    // English got no reminder at all, so a room set to English and speaking
    // Hinglish was answered in Hinglish every time.
    const { user } = buildInterventionPrompt(ctx({ language: 'english' }))
    expect(user).toContain('Language check: reply in English')
  })

  it('carries profanity permission only where it was granted', () => {
    const on = buildInterventionPrompt(ctx({ personality: 'straight_shooter', allowProfanity: true })).system
    expect(on).toContain('Strong language: On')

    // normalizeConversationSettings forces this off for any other personality,
    // so the prompt must never carry permission the participants never gave.
    const off = buildInterventionPrompt(ctx({ personality: 'diplomat', allowProfanity: true })).system
    expect(off).toContain('Strong language: Off')
  })
})

describe('the final-position imperatives', () => {
  it('states the verdict instruction as clean prose', () => {
    const { user } = buildInterventionPrompt({ ...baseCtx, askedForVerdict: true })
    expect(user).toContain('THEY HAVE ASKED YOU WHO IS RIGHT')
    expect(user).toContain('whose position is stronger and why')
    // It was assembled from a template literal that still contained the `" + "`
    // of the string concatenation it was converted from, so the most important
    // instruction in the prompt reached the model as garbled fragments.
    expect(user).not.toContain('" +')
    expect(user).not.toMatch(/stronger " /)
  })

  it('states the challenge instruction as clean prose', () => {
    const { user } = buildInterventionPrompt({ ...baseCtx, challengedByParticipant: true })
    expect(user).toContain('THIS IS A COMPLAINT ABOUT YOU')
    expect(user).not.toContain('" +')
  })

  it('puts them after the cooldown line, with only the language reminder below', () => {
    // Final position is the only place these have ever held; three mid-prompt
    // versions produced three different evasions.
    //
    // The one-line language reminder sits below them deliberately. Putting the
    // imperatives dead last buried it under a shouted paragraph, and three of
    // four challenge replies in a Hinglish room came back in English.
    const { user } = buildInterventionPrompt({ ...baseCtx, challengedByParticipant: true })
    const challenge = user.indexOf('THIS IS A COMPLAINT ABOUT YOU')
    expect(challenge).toBeGreaterThan(user.indexOf('since Urushi last spoke'))
    expect(user.indexOf('Language check')).toBeGreaterThan(challenge)
    expect(user.trimEnd()).toMatch(/Language check[^\n]*$/)
  })

  it('drops the escape hatch for the personality that exists to give verdicts', () => {
    // Offered unconditionally, every personality took it — a position was
    // actually taken in 1 of 2 Straight Shooter runs and 0 of 4 for the others.
    // An out that is always available is the one the model always chooses.
    const shooter = buildInterventionPrompt({
      ...baseCtx,
      settings: normalizeConversationSettings({ personality: 'straight_shooter' }),
      askedForVerdict: true,
    }).user
    expect(shooter).toContain('you can call this one')
    expect(shooter).not.toContain('If the conversation genuinely does not contain enough to judge')

    const diplomat = buildInterventionPrompt({
      ...baseCtx,
      settings: normalizeConversationSettings({ personality: 'diplomat' }),
      askedForVerdict: true,
    }).user
    expect(diplomat).toContain('If the conversation genuinely does not contain enough to judge')
  })

  it('carries a previous verdict into the imperative that overrides the repetition guard', () => {
    // Asked a second time it returned its previous verdict word for word in
    // every run tested: the mid-message repetition guard loses to this
    // imperative, so the prior verdict has to travel with it.
    const { user } = buildInterventionPrompt({
      ...baseCtx,
      askedForVerdict: true,
      recentSpokenActions: ['GIVE_VERDICT', 'CLARIFY'],
      recentSpokenTexts: ['On this point, Manan is right.'],
    })
    expect(user).toContain('You have ALREADY given a verdict on this')
    expect(user).toContain('On this point, Manan is right.')
  })

  it('does not warn about a previous verdict when there was not one', () => {
    const { user } = buildInterventionPrompt({
      ...baseCtx,
      askedForVerdict: true,
      recentSpokenActions: ['CLARIFY'],
      recentSpokenTexts: ['What date did you agree?'],
    })
    expect(user).not.toContain('ALREADY given a verdict')
  })

  it('omits them entirely when neither applies', () => {
    const { user } = buildInterventionPrompt(baseCtx)
    expect(user).not.toContain('THEY HAVE ASKED YOU')
    expect(user).not.toContain('THIS IS A COMPLAINT ABOUT YOU')
  })
})

describe('the echo guard', () => {
  it('lists recent turns at the end, where instructions hold', () => {
    // The mid-message repetition block already named these and lost: one run
    // closed four separate turns with the same sentence.
    const { user } = buildInterventionPrompt({
      ...baseCtx,
      recentSpokenTexts: ['Ab aage kaise proceed karna hai, uspe focus karte hain.'],
    })
    const echo = user.lastIndexOf('Do not reuse any sentence')
    expect(echo).toBeGreaterThan(user.indexOf('since Urushi last spoke'))
    expect(user.slice(echo)).toContain('uspe focus karte hain')
  })

  it('says nothing when there are no previous turns to echo', () => {
    expect(buildInterventionPrompt(baseCtx).user).not.toContain('Do not reuse any sentence')
  })
})
