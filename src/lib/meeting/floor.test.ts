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
    // 1.5 s: a breath between sentences. At 4 s a live argument never read as
    // clear and every intervention fell back to chat.
    const s = markPartial(EMPTY_RUNTIME_STATE, t0)
    expect(isFloorOccupied(s, t0 + 1_000)).toBe(true)
    expect(isFloorOccupied(s, t0 + 2_000)).toBe(false)
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

describe('bot status on the tile', () => {
  it('records the state and when it changed', async () => {
    const { setBotStatus } = await import('./runtimeState')
    const s = setBotStatus(EMPTY_RUNTIME_STATE, 'thinking', t0)
    expect(s.botStatus).toBe('thinking')
    expect(s.botStatusAt).toBe(t0)
    // Flipping status must not disturb the floor tracking it shares a row with.
    expect(isFloorOccupied(s, t0)).toBe(false)
  })
})

describe('floor and tile state survive persistence', () => {
  // The test that was missing. The helpers above were tested in memory and
  // never through parseRuntimeState, which is a whitelist: the fields existed
  // on the interface, were written to the database correctly, and were dropped
  // on every read. The deployed floor check therefore always saw a clear floor.
  it('round-trips speakingNow, lastPartialAt and botStatus through the parser', async () => {
    const { parseRuntimeState, setBotStatus } = await import('./runtimeState')
    let s = markSpeaking(EMPTY_RUNTIME_STATE, '42', true, t0)
    s = markPartial(s, t0 + 500)
    s = setBotStatus(s, 'thinking', t0 + 800)

    const back = parseRuntimeState(JSON.parse(JSON.stringify(s)))
    expect(back.speakingNow).toEqual({ '42': t0 })
    expect(back.lastPartialAt).toBe(t0 + 500)
    expect(back.botStatus).toBe('thinking')
    expect(back.botStatusAt).toBe(t0 + 800)
    expect(isFloorOccupied(back, t0 + 1_000)).toBe(true)
  })

  it('drops a corrupt speakingNow rather than letting it poison the floor check', async () => {
    const { parseRuntimeState } = await import('./runtimeState')
    const back = parseRuntimeState({ speakingNow: { a: 'not-a-number', b: t0 }, botStatus: 'bogus' })
    expect(back.speakingNow).toEqual({ b: t0 })
    expect(back.botStatus).toBeUndefined()
  })
})
