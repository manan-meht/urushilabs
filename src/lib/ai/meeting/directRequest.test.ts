import { describe, it, expect } from 'vitest'
import { preGate, type EngineContext } from './interventionEngine'
import { EMPTY_RUNTIME_STATE } from '@/lib/meeting/runtimeState'
import { detectDirectAddress } from '@/lib/ai/room/directAddress'

// A context where Urushi spoke a second ago, so the cooldown would normally win.
function justSpoke(text: string): EngineContext {
  const now = 1_700_000_000_000
  return {
    settings: {
      personality: 'diplomat', region: 'india', language: 'english', languageStyle: 'clean',
      interventionLevel: 'facilitator', voiceGender: 'female',
    } as unknown as EngineContext['settings'],
    state: { ...EMPTY_RUNTIME_STATE, urushiLastSpokeAt: now - 1_000 },
    override: { mode: 'NONE' } as unknown as EngineContext['override'],
    topic: 'Report deadline',
    participantNames: ['Vikram', 'Priya'],
    latestUtterance: { speaker: 'Vikram', text },
    recentTranscript: [],
    now,
  }
}

describe('being asked by name is never rationed', () => {
  // Said in a real session, dropped on cooldown before any model call. Seven
  // such requests across two meetings, zero replies.
  const asked = [
    'Urushi do you want to summarize what we discussed?',
    'Urushi, can you confirm what was agreed?',
    'Urushi, could you recap where we are?',
    'Okay Urushi, what do you think?',
  ]

  for (const text of asked) {
    it(`bypasses the cooldown for: "${text}"`, () => {
      expect(detectDirectAddress(text)).toBe(true)
      const gate = preGate(justSpoke(text))
      expect(gate.proceed).toBe(true)
      expect(gate.forcedReason).toBe('DIRECT_REQUEST')
    })
  }

  it('still respects the cooldown when Urushi is merely mentioned', () => {
    // "Urushi has been quiet" is about the mediator, not to it.
    expect(detectDirectAddress('Urushi has been very quiet today.')).toBe(false)
    const gate = preGate(justSpoke('Urushi has been very quiet today.'))
    expect(gate.proceed).toBe(false)
    expect(gate.suppressedBy).toBe('cooldown')
  })

  it('does not fire on "Hi, Urushi" alone — a greeting is not a request', () => {
    expect(detectDirectAddress('Hi, urushi.')).toBe(false)
  })
})
