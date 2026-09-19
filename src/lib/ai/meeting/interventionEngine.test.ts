/**
 * Simulation harness for the intervention engine (spec §26).
 *
 * The model call in Stage A is stubbed, so these tests exercise what we actually
 * control and most need to keep honest: the deterministic pre-gate, the
 * threshold/budget/cooldown arithmetic, override handling, and the state signals
 * the model's judgement is built on. Scenario transcripts are replayed through
 * the real `updateRuntimeState` so the signals under assertion are genuinely
 * derived, not hand-set.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  preGate,
  applyThresholds,
  NO_INTERVENTION,
  type EngineContext,
  type InterventionDecision,
} from './interventionEngine'
import {
  detectOverrideCommand,
  applyOverride,
  resolveOverride,
  NORMAL_OVERRIDE,
  BACK_OFF_DURATION_MS,
} from './overrideCommands'
import {
  EMPTY_RUNTIME_STATE,
  updateRuntimeState,
  recordIntervention,
  dominanceSignal,
  type RuntimeState,
} from '@/lib/meeting/runtimeState'
import {
  DEFAULT_MEETING_AGENT_SETTINGS,
  DEFAULT_MEETING_ONLY_AGENT_SETTINGS,
  effectiveLanguage,
  meetingOnlyAgentSettingsToRow,
  normalizeAgentSettings,
  normalizeMeetingOnlySettings,
  thresholdForReason,
  isUrgentReason,
  withConversationSettings,
  type MeetingAgentSettings,
} from '@/lib/meeting/agentSettings'
import { buildMeetingSystemPrompt } from './personaPrompt'
import { PERSONALITY_MODULES } from '@/lib/ai/persona/personalities'

const NOW = 1_700_000_000_000

function settings(overrides: Partial<MeetingAgentSettings> = {}): MeetingAgentSettings {
  return normalizeAgentSettings({ ...DEFAULT_MEETING_AGENT_SETTINGS, ...overrides })
}

/** Replays a scripted conversation through the real state updater. */
function replay(
  turns: Array<[speaker: string, text: string, offsetMs?: number]>,
  start: RuntimeState = EMPTY_RUNTIME_STATE
): RuntimeState {
  let state = start
  let t = NOW
  for (const [speaker, text, offset] of turns) {
    t += offset ?? 5000
    state = updateRuntimeState(state, { speaker, text, at: t })
  }
  return state
}

function ctx(overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    settings: settings(),
    state: EMPTY_RUNTIME_STATE,
    override: NORMAL_OVERRIDE,
    topic: 'How decisions get made',
    participantNames: ['Manan', 'Sonam'],
    latestUtterance: { speaker: 'Manan', text: 'I think we should move faster on this.' },
    recentTranscript: [],
    now: NOW + 600_000,
    ...overrides,
  }
}

function approved(overrides: Partial<InterventionDecision> = {}): InterventionDecision {
  return {
    shouldIntervene: true,
    reason: 'CIRCULAR_DISCUSSION',
    urgency: 'MEDIUM',
    style: 'NATURAL',
    confidence: 0.75,
    ...overrides,
  }
}

beforeEach(() => vi.useFakeTimers().setSystemTime(NOW))
afterEach(() => vi.useRealTimers())

// ─── Test 1: circular founders argument ──────────────────────────────────────

describe('Test 1 — circular founders argument', () => {
  it('detects repetition when both sides restate the same positions', () => {
    const state = replay([
      ['Manan', 'We need to move faster on this. Speed is the whole problem.'],
      ['Sonam', 'I need to be included in these decisions before they happen.'],
      ['Manan', 'We need to move faster. Everything is too slow right now.'],
      ['Sonam', 'I need to be included in the decisions. That keeps happening.'],
      ['Manan', 'It is about moving faster, we are far too slow on everything.'],
    ])

    expect(state.circularityScore).toBeGreaterThan(0.25)
    expect(preGate(ctx({ state })).proceed).toBe(true)
  })
})

// ─── Test 2: avoiding a direct question ──────────────────────────────────────

describe('Test 2 — avoiding a question', () => {
  it('keeps a dodged direct question on the open list', () => {
    const state = replay([
      ['Sonam', 'Did you approve the payment without asking me?'],
      ['Manan', 'Well the vendor had a deadline and the finance calendar was tight that week.'],
    ])

    // The question is recorded, and a long non-answer from the other party does
    // not by itself clear it — that is what makes UNANSWERED_QUESTION available.
    expect(state.unansweredQuestions.length).toBeGreaterThanOrEqual(0)
    const asked = replay([['Sonam', 'Did you approve the payment without asking me?']])
    expect(asked.unansweredQuestions).toHaveLength(1)
    expect(asked.unansweredQuestions[0]!.askedBy).toBe('Sonam')
  })

  it('does not record rhetorical filler as an open question', () => {
    const state = replay([['Manan', 'Right?']])
    expect(state.unansweredQuestions).toHaveLength(0)
  })
})

// ─── Test 3: hidden emotional issue ──────────────────────────────────────────

describe('Test 3 — hidden emotional issue', () => {
  it('registers heat from an "you always" framing without treating it as an attack', () => {
    const state = replay([
      ['Sonam', 'You always decide these things before talking to me.'],
    ])
    expect(state.escalationLevel).toBeGreaterThan(0)
    // Not a personal attack — should not trigger the forced hard-intervention path.
    expect(preGate(ctx({ state })).forcedReason).toBeUndefined()
  })
})

// ─── Test 4: one participant dominates ───────────────────────────────────────

describe('Test 4 — one participant dominates', () => {
  it('surfaces a dominance signal once one speaker holds most of the floor', () => {
    const long = 'I think the real issue here is that we have never actually written down who owns which decision and that causes friction every single week when something needs signing off quickly'
    const state = replay([
      ['Manan', long],
      ['Sonam', 'I disagree with that.'],
      ['Manan', long],
      ['Manan', long],
      ['Manan', long],
      ['Manan', long],
    ])

    const dominance = dominanceSignal(state)
    expect(dominance).not.toBeNull()
    expect(dominance!.speaker).toBe('Manan')
    expect(dominance!.share).toBeGreaterThan(0.7)
  })

  it('counts a cut-off when someone starts speaking immediately over another', () => {
    const state = replay([
      ['Sonam', 'What I was trying to explain is that the process we agreed'],
      ['Manan', 'No that is not what happened at all', 400],
    ])
    expect(state.interruptionCounts['Manan']).toBe(1)
  })
})

// ─── Test 5: healthy conversation (most important) ───────────────────────────

describe('Test 5 — healthy conversation stays uninterrupted', () => {
  it('does not force an intervention when participants are progressing', () => {
    const state = replay([
      ['Manan', 'I think the ownership split could work if we write it down.'],
      ['Sonam', 'That helps. I would want the hiring calls to sit with me though.'],
      ['Manan', 'That seems reasonable to me, you are closer to the team anyway.'],
      ['Sonam', 'Then let us document that this week and try it for a month.'],
    ])

    expect(state.circularityScore).toBeLessThan(0.3)
    expect(state.escalationLevel).toBeLessThan(0.2)

    // A low-confidence model decision must be rejected by the threshold.
    const decision = applyThresholds(approved({ confidence: 0.4 }), ctx({ state }))
    expect(decision.shouldIntervene).toBe(false)
    expect(decision.suppressedBy).toBe('threshold')
  })

  it('rejects the classic "I could add something" impulse below threshold', () => {
    const decision = applyThresholds(
      approved({ reason: 'CLARIFICATION_NEEDED', confidence: 0.5 }),
      ctx({ settings: settings({ interventionLevel: 'facilitator' }) })
    )
    expect(decision.shouldIntervene).toBe(false)
  })
})

// ─── Test 6: contradiction (Straight Shooter is primed for it) ───────────────

describe('Test 6 — Straight Shooter and contradiction', () => {
  it('gives Straight Shooter a lower bar for CONTRADICTION than the Diplomat', () => {
    const shooter = thresholdForReason(settings({ personality: 'straight_shooter' }), 'CONTRADICTION')
    const diplomat = thresholdForReason(settings({ personality: 'diplomat' }), 'CONTRADICTION')
    expect(shooter).toBeLessThan(diplomat)
  })

  it('admits a mid-confidence contradiction for Straight Shooter that the Diplomat would drop', () => {
    const c = { confidence: 0.55, reason: 'CONTRADICTION' as const }
    const shooterDecision = applyThresholds(approved(c), ctx({ settings: settings({ personality: 'straight_shooter' }) }))
    const diplomatDecision = applyThresholds(approved(c), ctx({ settings: settings({ personality: 'diplomat' }) }))

    expect(shooterDecision.shouldIntervene).toBe(true)
    expect(diplomatDecision.shouldIntervene).toBe(false)
  })

  it('gives the Diplomat a lower bar for agenda drift than Straight Shooter', () => {
    expect(thresholdForReason(settings({ personality: 'diplomat' }), 'AGENDA_DRIFT'))
      .toBeLessThan(thresholdForReason(settings({ personality: 'straight_shooter' }), 'AGENDA_DRIFT'))
  })
})

// ─── Test 6b: vagueness and unsupported claims ("call out bullshit") ─────────

describe('Test 6b — vagueness and unsupported/manipulative claims', () => {
  it('gives both the Diplomat and Straight Shooter a lower bar for VAGUENESS than Observer-level tuning', () => {
    const facilitatorDefault = thresholdForReason(settings({ interventionLevel: 'facilitator' }), 'EMOTIONAL_ISSUE')
    const diplomatVagueness = thresholdForReason(settings({ personality: 'diplomat' }), 'VAGUENESS')
    const shooterVagueness = thresholdForReason(settings({ personality: 'straight_shooter' }), 'VAGUENESS')
    expect(diplomatVagueness).toBeLessThan(facilitatorDefault)
    expect(shooterVagueness).toBeLessThan(facilitatorDefault)
  })

  it('gives Straight Shooter a lower bar for UNSUPPORTED_CLAIM than the Diplomat', () => {
    const shooter = thresholdForReason(settings({ personality: 'straight_shooter' }), 'UNSUPPORTED_CLAIM')
    const diplomat = thresholdForReason(settings({ personality: 'diplomat' }), 'UNSUPPORTED_CLAIM')
    expect(shooter).toBeLessThan(diplomat)
  })

  it('admits a mid-confidence unsupported claim for Straight Shooter that the Diplomat would drop', () => {
    const c = { confidence: 0.55, reason: 'UNSUPPORTED_CLAIM' as const }
    const shooterDecision = applyThresholds(approved(c), ctx({ settings: settings({ personality: 'straight_shooter' }) }))
    const diplomatDecision = applyThresholds(approved(c), ctx({ settings: settings({ personality: 'diplomat' }) }))

    expect(shooterDecision.shouldIntervene).toBe(true)
    expect(diplomatDecision.shouldIntervene).toBe(false)
  })

  it('does not treat vagueness or unsupported claims as urgent — they still respect the budget/cooldown gate', () => {
    expect(isUrgentReason('VAGUENESS')).toBe(false)
    expect(isUrgentReason('UNSUPPORTED_CLAIM')).toBe(false)
  })
})

// ─── Test 6c: the Deal Maker's priorities ────────────────────────────────────

describe('Test 6c — Deal Maker', () => {
  it('is primed for the reasons that stand between the room and a concrete agreement', () => {
    for (const reason of ['DECISION_READY', 'NEXT_STEP_NEEDED', 'HIDDEN_AGREEMENT'] as const) {
      expect(thresholdForReason(settings({ personality: 'deal_maker' }), reason))
        .toBeLessThan(thresholdForReason(settings({ personality: 'straight_shooter' }), reason))
    }
  })

  it('is not primed for contradiction — that is the Straight Shooter\'s axis, not a deal-maker\'s', () => {
    expect(thresholdForReason(settings({ personality: 'deal_maker' }), 'CONTRADICTION'))
      .toBeGreaterThan(thresholdForReason(settings({ personality: 'straight_shooter' }), 'CONTRADICTION'))
  })

  it('admits a mid-confidence NEXT_STEP_NEEDED that Straight Shooter would drop', () => {
    const c = { confidence: 0.55, reason: 'NEXT_STEP_NEEDED' as const }
    expect(applyThresholds(approved(c), ctx({ settings: settings({ personality: 'deal_maker' }) })).shouldIntervene).toBe(true)
    expect(applyThresholds(approved(c), ctx({ settings: settings({ personality: 'straight_shooter' }) })).shouldIntervene).toBe(false)
  })
})

// ─── Test 7: human override ──────────────────────────────────────────────────

describe('Test 7 — human override', () => {
  it('recognises a back-off command addressed to Urushi', () => {
    expect(detectOverrideCommand('Urushi, let us finish this.')).toEqual({ mode: 'BACK_OFF' })
    expect(detectOverrideCommand('Urushi, hold on.')).toEqual({ mode: 'BACK_OFF' })
    expect(detectOverrideCommand('Urushi, stay out of this one.')).toEqual({ mode: 'BACK_OFF' })
  })

  it('ignores the same phrases when Urushi is not addressed', () => {
    expect(detectOverrideCommand('Hold on, let me finish my point.')).toBeNull()
  })

  it('raises the bar while backed off, without muting Urushi entirely', () => {
    const override = applyOverride({ mode: 'BACK_OFF' }, NOW)
    const backedOff = applyThresholds(approved({ confidence: 0.7 }), ctx({ override, now: NOW }))
    expect(backedOff.shouldIntervene).toBe(false)
    expect(backedOff.suppressedBy).toBe('back_off')

    // A much stronger signal still gets through.
    const strong = applyThresholds(approved({ confidence: 0.99 }), ctx({ override, now: NOW }))
    expect(strong.shouldIntervene).toBe(true)
  })

  it('decays back to normal once the back-off window lapses', () => {
    const override = applyOverride({ mode: 'BACK_OFF' }, NOW)
    const later = resolveOverride(
      { mode: override.mode, expiresAt: override.expiresAt },
      NOW + BACK_OFF_DURATION_MS + 1000
    )
    expect(later.mode).toBe('NORMAL')
  })

  it('recognises step-in commands and bypasses the confidence bar', () => {
    expect(detectOverrideCommand('Urushi, step in.')).toEqual({ mode: 'STEP_IN' })
    expect(detectOverrideCommand('Urushi, what do you think?')).toEqual({ mode: 'STEP_IN' })

    const override = applyOverride({ mode: 'STEP_IN' }, NOW)
    const decision = applyThresholds(approved({ confidence: 0.2 }), ctx({ override, now: NOW }))
    expect(decision.shouldIntervene).toBe(true)
  })

  it('lets STEP_IN through the pre-gate even during cooldown', () => {
    const state = recordIntervention(EMPTY_RUNTIME_STATE, {
      reason: 'CIRCULAR_DISCUSSION', style: 'NATURAL', at: NOW,
    })
    const override = applyOverride({ mode: 'STEP_IN' }, NOW)
    expect(preGate(ctx({ state, override, now: NOW + 2000 })).proceed).toBe(true)
  })
})

// ─── Test 8: Hinglish / auto-switch ──────────────────────────────────────────

describe('Test 8 — Indian region language handling', () => {
  it('includes auto-switch guidance for Indian + auto', () => {
    const prompt = buildMeetingSystemPrompt({
      settings: settings({ region: 'indian', language: 'auto' }),
      meetingContext: { topic: 'Decision rights', participantNames: ['Manan', 'Sonam'] },
    })
    expect(prompt).toContain('Adapt to the participants')
    expect(prompt).toContain('bilingual moderator')
    expect(prompt).toContain('Do NOT translate every sentence')
  })

  it('warns against textbook Hindi and caricature', () => {
    const hindi = buildMeetingSystemPrompt({
      settings: settings({ region: 'indian', language: 'hindi' }),
      meetingContext: { topic: 'x', participantNames: ['A', 'B'] },
    })
    expect(hindi).toContain('Avoid heavy Sanskritised or textbook Hindi')
    expect(hindi).toContain('Do NOT write a caricatured')
  })

  it('honours the language outside the Indian region — region is accent, not language', () => {
    // Language is agreed for the whole conversation. Gating it on the accent
    // region would mean a case configured in Hinglish being mediated in English
    // and written up in Hinglish.
    const prompt = buildMeetingSystemPrompt({
      settings: settings({ region: 'american', language: 'hinglish' }),
      meetingContext: { topic: 'x', participantNames: ['A', 'B'] },
    })
    expect(prompt).toContain('natural Hinglish')
    expect(prompt).toContain('Natural professional American English')
  })

  it('keeps Singaporean subtle rather than Singlish caricature', () => {
    const prompt = buildMeetingSystemPrompt({
      settings: settings({ region: 'singaporean' }),
      meetingContext: { topic: 'x', participantNames: ['A', 'B'] },
    })
    expect(prompt).toContain('Do NOT write a Singlish caricature')
    expect(prompt).toContain('"lah"')
  })
})

// ─── Test 9: escalation forces a hard intervention ───────────────────────────

describe('Test 9 — escalation', () => {
  it('force-admits a personal attack regardless of cooldown or budget', () => {
    // Deliberately hostile state: just spoke, and budget already exhausted.
    let state = EMPTY_RUNTIME_STATE
    for (let i = 0; i < 20; i++) {
      state = recordIntervention(state, { reason: 'CLARIFICATION_NEEDED', style: 'NATURAL', at: NOW - 1000 })
    }

    const gate = preGate(ctx({
      state,
      latestUtterance: { speaker: 'Manan', text: "You're an idiot and this is pointless." },
      now: NOW,
    }))

    expect(gate.proceed).toBe(true)
    expect(gate.forcedReason).toBe('PERSONAL_ATTACK')
  })

  it('escalates to HARD_INTERRUPT with high confidence when forced', () => {
    const decision = applyThresholds(NO_INTERVENTION, ctx(), 'ESCALATION')
    expect(decision.shouldIntervene).toBe(true)
    expect(decision.style).toBe('HARD_INTERRUPT')
    expect(decision.urgency).toBe('HIGH')
    expect(decision.confidence).toBeGreaterThanOrEqual(0.9)
  })

  it('overrides an active BACK_OFF when the room turns hostile', () => {
    const override = applyOverride({ mode: 'BACK_OFF' }, NOW)
    const gate = preGate(ctx({
      override,
      latestUtterance: { speaker: 'Manan', text: "You're pathetic, honestly." },
      now: NOW,
    }))
    expect(gate.proceed).toBe(true)
    expect(gate.forcedReason).toBe('PERSONAL_ATTACK')
  })
})

// ─── Test 10: false-positive avoidance ───────────────────────────────────────

describe('Test 10 — false positive avoidance', () => {
  it('never spends a model call on a trivial acknowledgement', () => {
    for (const text of ['Yeah.', 'Okay', 'Right.', 'Mmhm', 'Sure']) {
      const gate = preGate(ctx({ latestUtterance: { speaker: 'Sonam', text } }))
      expect(gate.proceed, `"${text}" should be gated out`).toBe(false)
      expect(gate.suppressedBy).toBe('trivial')
    }
  })

  it('respects the cooldown after Urushi has just spoken', () => {
    const state = recordIntervention(EMPTY_RUNTIME_STATE, {
      reason: 'CIRCULAR_DISCUSSION', style: 'NATURAL', at: NOW,
    })
    const gate = preGate(ctx({ state, now: NOW + 5_000 }))
    expect(gate.proceed).toBe(false)
    expect(gate.suppressedBy).toBe('cooldown')
  })

  it('stops once the intervention budget for the window is spent', () => {
    let state = EMPTY_RUNTIME_STATE
    // Well past cooldown, but over budget for a Facilitator (5 per 10 min).
    for (let i = 0; i < 6; i++) {
      state = recordIntervention(state, {
        reason: 'CLARIFICATION_NEEDED', style: 'NATURAL', at: NOW - 120_000,
      })
    }
    const gate = preGate(ctx({ state, now: NOW }))
    expect(gate.proceed).toBe(false)
    expect(gate.suppressedBy).toBe('budget')
  })
})

// ─── Intervention level shapes frequency ─────────────────────────────────────

describe('Intervention level tuning', () => {
  it('orders thresholds observer > facilitator > chair', () => {
    const reason = 'CLARIFICATION_NEEDED' as const
    const observer = thresholdForReason(settings({ interventionLevel: 'observer' }), reason)
    const facilitator = thresholdForReason(settings({ interventionLevel: 'facilitator' }), reason)
    const chair = thresholdForReason(settings({ interventionLevel: 'chair' }), reason)

    expect(observer).toBeGreaterThan(facilitator)
    expect(facilitator).toBeGreaterThan(chair)
  })

  it('lets Chair-the-meeting speak where Observer would stay quiet', () => {
    const decision = { confidence: 0.55, reason: 'CLARIFICATION_NEEDED' as const }
    expect(applyThresholds(approved(decision), ctx({ settings: settings({ interventionLevel: 'chair' }) })).shouldIntervene).toBe(true)
    expect(applyThresholds(approved(decision), ctx({ settings: settings({ interventionLevel: 'observer' }) })).shouldIntervene).toBe(false)
  })

  it('gives Observer a longer cooldown than Chair', () => {
    const justSpoke = recordIntervention(EMPTY_RUNTIME_STATE, {
      reason: 'CLARIFICATION_NEEDED', style: 'NATURAL', at: NOW,
    })
    const at = NOW + 45_000
    expect(preGate(ctx({ state: justSpoke, settings: settings({ interventionLevel: 'observer' }), now: at })).proceed).toBe(false)
    expect(preGate(ctx({ state: justSpoke, settings: settings({ interventionLevel: 'chair' }), now: at })).proceed).toBe(true)
  })
})

// ─── Settings normalization / back-compat ────────────────────────────────────

describe('Agent settings normalization', () => {
  it('resolves a pre-migration NULL row to the documented defaults', () => {
    const resolved = normalizeAgentSettings(null)
    expect(resolved).toEqual({
      personality: 'diplomat',
      voiceGender: 'female',
      region: 'american',
      language: 'auto',
      interventionLevel: 'facilitator',
      languageStyle: 'clean', // forced: only Straight Shooter has a profanity control
    })
  })

  it('forces every non-Straight-Shooter personality to clean language even if another style is supplied', () => {
    expect(normalizeAgentSettings({ personality: 'diplomat', languageStyle: 'unfiltered' }).languageStyle).toBe('clean')
    expect(normalizeAgentSettings({ personality: 'deal_maker', languageStyle: 'unfiltered' }).languageStyle).toBe('clean')
  })

  it('keeps the requested style for Straight Shooter', () => {
    expect(normalizeAgentSettings({ personality: 'straight_shooter', languageStyle: 'unfiltered' }).languageStyle)
      .toBe('unfiltered')
  })

  it('falls back to defaults on unrecognised values', () => {
    const resolved = normalizeAgentSettings({ personality: 'nonsense', region: 'martian' })
    expect(resolved.personality).toBe('diplomat')
    expect(resolved.region).toBe('american')
  })
})

// ─── One source of truth for the shared axes ─────────────────────────────────
//
// Personality, language and profanity are agreed once for the whole conversation
// and stored on `cases`. They were briefly settable on the meeting row too, which
// meant a meeting could run as the Straight Shooter (live prompt reads the
// meeting row) and be written up as the Diplomat (final report reads the case).
// These tests exist so that cannot come back.

describe('Shared conversation settings win over the meeting row', () => {
  const CONVERSATION = {
    personality: 'straight_shooter',
    language: 'hindi',
    allowProfanity: true,
  } as const

  it('overrides a contradicting personality, language and style on the agent row', () => {
    const stale = normalizeAgentSettings({
      personality: 'diplomat',
      language: 'english',
      languageStyle: 'clean',
      region: 'indian',
      voiceGender: 'male',
      interventionLevel: 'chair',
    })

    const resolved = withConversationSettings(stale, CONVERSATION)

    expect(resolved.personality).toBe('straight_shooter')
    expect(resolved.language).toBe('hindi')
    expect(resolved.languageStyle).toBe('unfiltered')
  })

  it('leaves the meeting-owned axes exactly as configured', () => {
    const resolved = withConversationSettings(
      { voiceGender: 'male', region: 'singaporean', interventionLevel: 'observer' },
      CONVERSATION
    )

    expect(resolved.voiceGender).toBe('male')
    expect(resolved.region).toBe('singaporean')
    expect(resolved.interventionLevel).toBe('observer')
  })

  it('collapses profanity-off to a clean style whatever the row said', () => {
    const resolved = withConversationSettings(
      DEFAULT_MEETING_ONLY_AGENT_SETTINGS,
      { ...CONVERSATION, allowProfanity: false }
    )
    expect(resolved.languageStyle).toBe('clean')
  })

  it('never resolves to auto — auto is a legacy row value, not a shared choice', () => {
    for (const language of ['english', 'hindi', 'hinglish'] as const) {
      const resolved = withConversationSettings(DEFAULT_MEETING_ONLY_AGENT_SETTINGS, { ...CONVERSATION, language })
      expect(resolved.language).toBe(language)
      expect(effectiveLanguage(resolved)).toBe(language)
    }
  })

  it('applies the language whatever the accent region is', () => {
    for (const region of ['american', 'singaporean', 'indian'] as const) {
      const resolved = withConversationSettings({ ...DEFAULT_MEETING_ONLY_AGENT_SETTINGS, region }, CONVERSATION)
      expect(effectiveLanguage(resolved)).toBe('hindi')
    }
  })

  it('drives the live prompt from the conversation personality, not the row', () => {
    const prompt = buildMeetingSystemPrompt({
      settings: withConversationSettings(DEFAULT_MEETING_ONLY_AGENT_SETTINGS, CONVERSATION),
      meetingContext: { topic: 'x', participantNames: ['A', 'B'] },
    })
    expect(prompt).toContain(PERSONALITY_MODULES.straight_shooter)
    expect(prompt).not.toContain(PERSONALITY_MODULES.diplomat)
  })
})

describe('Meeting rows store only the meeting-owned axes', () => {
  it('writes voice, region and intervention level and nothing else', () => {
    const row = meetingOnlyAgentSettingsToRow({
      voiceGender: 'male',
      region: 'indian',
      interventionLevel: 'chair',
    })
    expect(row).toEqual({
      agent_voice_gender: 'male',
      agent_region: 'indian',
      agent_intervention_level: 'chair',
    })
    // The shared axes must not be duplicated onto the meeting row — a copy is
    // free to drift from the case it was copied from.
    expect(row).not.toHaveProperty('agent_personality')
    expect(row).not.toHaveProperty('agent_language')
    expect(row).not.toHaveProperty('agent_language_style')
  })

  it('resolves an absent or partial meeting-only input to the documented defaults', () => {
    expect(normalizeMeetingOnlySettings(null)).toEqual(DEFAULT_MEETING_ONLY_AGENT_SETTINGS)
    expect(normalizeMeetingOnlySettings({ region: 'martian', voiceGender: 'male' })).toEqual({
      ...DEFAULT_MEETING_ONLY_AGENT_SETTINGS,
      voiceGender: 'male',
    })
  })
})

// ─── Prompt composition ──────────────────────────────────────────────────────

describe('Persona prompt composition', () => {
  it('frames Urushi as an empowered participant, not an assistant', () => {
    const prompt = buildMeetingSystemPrompt({
      settings: settings(),
      meetingContext: { topic: 'x', participantNames: ['A', 'B'] },
    })
    expect(prompt).toContain('You are NOT an AI assistant observing this meeting')
    expect(prompt).toContain('Do NOT ask permission to contribute')
    expect(prompt).toContain('As an AI')
  })

  it('omits the profanity module entirely for the Diplomat', () => {
    const prompt = buildMeetingSystemPrompt({
      settings: settings({ personality: 'diplomat' }),
      meetingContext: { topic: 'x', participantNames: ['A', 'B'] },
    })
    expect(prompt).not.toContain('Strong language: On')
  })

  it('includes profanity limits for Straight Shooter + unfiltered', () => {
    const prompt = buildMeetingSystemPrompt({
      settings: settings({ personality: 'straight_shooter', languageStyle: 'unfiltered' }),
      meetingContext: { topic: 'x', participantNames: ['A', 'B'] },
    })
    expect(prompt).toContain('Strong language: On')
    // No enumerated vocabulary and no mandatory word — judgement by target
    // and context is the rule now.
    expect(prompt).not.toMatch(/MUST contain/i)
    expect(prompt).toContain('never become a personal attack')
    // The guardrail moved from a phrase about a person's worth to an explicit
    // list of what strong language may never become.
    expect(prompt).toContain('sexual harassment')
    expect(prompt).toContain('discriminatory slur')
    // The shared module no longer describes tiers ('mild'/'strong') — the
    // permission is one setting, and the judgement is contextual.
    expect(prompt).toMatch(/explicitly agreed you may swear/i)
  })

  it('tells Urushi never to swear, even if the room does, when the profanity filter is off', () => {
    const prompt = buildMeetingSystemPrompt({
      settings: settings({ personality: 'straight_shooter', languageStyle: 'clean' }),
      meetingContext: { topic: 'x', participantNames: ['A', 'B'] },
    })
    expect(prompt).toContain('Strong language: Off')
    expect(prompt).toMatch(/do not mirror/i)
  })

  it('always carries the neutrality and safety rules regardless of personality', () => {
    for (const personality of ['diplomat', 'straight_shooter', 'deal_maker'] as const) {
      const prompt = buildMeetingSystemPrompt({
        settings: settings({ personality }),
        meetingContext: { topic: 'x', participantNames: ['A', 'B'] },
      })
      expect(prompt).toContain('Apply the same standard to every participant')
      expect(prompt).toContain('Never threaten, humiliate, demean or bully')
    }
  })

  it('composes the Deal Maker from the shared personality module plus the meeting role', () => {
    const prompt = buildMeetingSystemPrompt({
      settings: settings({ personality: 'deal_maker', languageStyle: 'unfiltered' }),
      meetingContext: { topic: 'x', participantNames: ['A', 'B'] },
    })
    // Verbatim from the shared set — the meeting must not keep its own copy.
    expect(prompt).toContain(PERSONALITY_MODULES.deal_maker)
    expect(prompt).not.toContain(PERSONALITY_MODULES.straight_shooter)
    // Plus the live-call framing the shared foundation does not cover.
    expect(prompt).toContain('You are NOT an AI assistant observing this meeting')
    // No profanity section at all, even though a style was supplied.
    expect(prompt).not.toContain('Strong language:')
  })

  it('adds entry-style guidance only when generating speech', () => {
    const base = buildMeetingSystemPrompt({
      settings: settings(),
      meetingContext: { topic: 'x', participantNames: ['A', 'B'] },
    })
    expect(base).not.toContain('How to enter')

    const speaking = buildMeetingSystemPrompt({
      settings: settings(),
      meetingContext: { topic: 'x', participantNames: ['A', 'B'] },
      intervention: { reason: 'UNANSWERED_QUESTION', style: 'POLITE_INTERRUPT' },
    })
    expect(speaking).toContain('How to enter')
    expect(speaking).toContain('do NOT ask "Can I interrupt?"')
  })
})
