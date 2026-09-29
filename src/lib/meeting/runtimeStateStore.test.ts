import { describe, it, expect } from 'vitest'
import { controllerFields, speakingPatch } from './runtimeStateStore'
import { EMPTY_RUNTIME_STATE, markSpeaking, setBotStatus, updateRuntimeState } from './runtimeState'

describe('controllerFields', () => {
  // The pipeline persisted its whole in-memory state after 20-30 s of model
  // calls, erasing every speech event and tile flip written in between. It may
  // now only ever write the keys it owns.
  it('never carries the floor or the tile, even when the in-memory state has them', () => {
    let s = updateRuntimeState(EMPTY_RUNTIME_STATE, { speaker: 'A', text: 'we agreed friday', at: 1_000 })
    s = markSpeaking(s, 'p1', true, 2_000)
    s = setBotStatus(s, 'thinking', 3_000)

    const patch = controllerFields(s) as Record<string, unknown>
    expect(patch).not.toHaveProperty('speakingNow')
    expect(patch).not.toHaveProperty('lastPartialAt')
    expect(patch).not.toHaveProperty('botStatus')
    expect(patch).not.toHaveProperty('botStatusAt')
    expect(patch['wordsBySpeaker']).toEqual({ A: 3 })
    expect(patch['lastUtteranceAt']).toBe(1_000)
  })

  it('omits undefined optionals so a merge cannot null them out', () => {
    const patch = controllerFields(EMPTY_RUNTIME_STATE) as Record<string, unknown>
    expect(patch).not.toHaveProperty('urushiLastSpokeAt')
    expect(patch).not.toHaveProperty('startedAt')
  })
})

describe('speakingPatch', () => {
  it('sets the participant on speech_on and nulls them on speech_off', () => {
    expect(speakingPatch('p1', true, 5_000)).toEqual({ speakingNow: { p1: 5_000 } })
    expect(speakingPatch('p1', false, 6_000)).toEqual({ speakingNow: { p1: null } })
  })

  it('marks the partial moment only for partial transcripts', () => {
    expect(speakingPatch('p1', true, 5_000, true)).toEqual({ speakingNow: { p1: 5_000 }, lastPartialAt: 5_000 })
  })
})
