import { describe, it, expect } from 'vitest'
import { EMPTY_RUNTIME_STATE, markSpeaking, markPartial, isFloorOccupied } from './runtimeState'

const t0 = 1_700_000_000_000

describe('who has the floor', () => {
  it('is occupied after speech_on and clear after speech_off', () => {
    // In two live sessions every one of Urushi's eight interventions began while
    // a human had already started talking. Recall's speech_on/off events were
    // subscribed and discarded; nothing tracked the floor at all.
    let s = markSpeaking(EMPTY_RUNTIME_STATE, '42', true, t0)
    expect(isFloorOccupied(s, t0 + 2_000)).toBe(true)
    s = markSpeaking(s, '42', false, t0 + 5_000)
    expect(isFloorOccupied(s, t0 + 6_000)).toBe(false)
  })

  it('treats a recent partial transcript as someone mid-sentence', () => {
    const s = markPartial(EMPTY_RUNTIME_STATE, t0)
    expect(isFloorOccupied(s, t0 + 3_000)).toBe(true)
    expect(isFloorOccupied(s, t0 + 6_000)).toBe(false)
  })

  it('does not stay muted forever after a missed speech_off', () => {
    // One dropped webhook must not silence Urushi for the rest of the meeting.
    const s = markSpeaking(EMPTY_RUNTIME_STATE, '42', true, t0)
    expect(isFloorOccupied(s, t0 + 60_000)).toBe(false)
  })

  it('stays occupied while anyone is still talking', () => {
    let s = markSpeaking(EMPTY_RUNTIME_STATE, '42', true, t0)
    s = markSpeaking(s, '43', true, t0 + 1_000)
    s = markSpeaking(s, '42', false, t0 + 2_000)
    expect(isFloorOccupied(s, t0 + 3_000)).toBe(true)
  })

  it('tolerates state persisted before speakingNow existed', () => {
    const legacy = { ...EMPTY_RUNTIME_STATE }
    delete (legacy as { speakingNow?: unknown }).speakingNow
    expect(isFloorOccupied(legacy, t0)).toBe(false)
    expect(isFloorOccupied(markSpeaking(legacy, '1', true, t0), t0 + 1)).toBe(true)
  })
})
