import { describe, it, expect } from 'vitest'
import { costOf, hasRate, MODEL_RATES, REALTIME_AUDIO_RATES } from './modelCosts'

describe('costOf', () => {
  it('prices a typical controller call', () => {
    // The measured shape: ~6k input, ~200 output, on the current model.
    const cost = costOf('gpt-4o', { inputTokens: 6000, outputTokens: 200 })
    expect(cost).toBeCloseTo(6000 * 2.5 / 1e6 + 200 * 10 / 1e6, 8)
  })

  it('charges cached input at the cached rate', () => {
    // The system prompt is identical across a session, so the cache-hit rate is
    // the difference between a cheap session and a dear one. Counting cached
    // tokens at full price would hide that entirely.
    const uncached = costOf('gpt-4o', { inputTokens: 6000, outputTokens: 0 })
    const cached = costOf('gpt-4o', { inputTokens: 6000, outputTokens: 0, cachedInputTokens: 5000 })
    expect(cached).toBeLessThan(uncached)
  })

  it('never counts cached tokens twice', () => {
    const all = costOf('gpt-4o', { inputTokens: 1000, outputTokens: 0, cachedInputTokens: 1000 })
    expect(all).toBeCloseTo(1000 * 1.25 / 1e6, 8)
  })

  it('does not go negative when cached exceeds reported input', () => {
    // Defensive: the two numbers come from different fields of the API
    // response, and a mediation must not be disturbed by arithmetic here.
    expect(costOf('gpt-4o', { inputTokens: 100, outputTokens: 0, cachedInputTokens: 500 }))
      .toBeGreaterThanOrEqual(0)
  })

  it('returns zero for an unknown model rather than throwing', () => {
    // A missing rate must never take down a mediation. Recording happens
    // beside the work, not in its way.
    expect(costOf('some-model-shipped-tomorrow', { inputTokens: 1000, outputTokens: 100 })).toBe(0)
    expect(hasRate('some-model-shipped-tomorrow')).toBe(false)
  })

  it('shows the newer model is dramatically cheaper for the same work', () => {
    // The reason this file exists: a heavy session is ~150 calls at ~6k input.
    const heavy = { inputTokens: 6000 * 150, outputTokens: 200 * 150 }
    const now = costOf('gpt-4o', heavy)
    const luna = costOf('gpt-6-luna', heavy)
    expect(now).toBeGreaterThan(2)
    expect(luna).toBeLessThan(0.2)
    expect(now / luna).toBeGreaterThan(20)
  })

  it('prices realtime audio from its own table', () => {
    // Audio is billed at a different rate from text on the same model name, so
    // it cannot share a lookup.
    const audio = costOf('gpt-realtime-2.1', { inputTokens: 18_000, outputTokens: 1_800 }, REALTIME_AUDIO_RATES)
    expect(audio).toBeCloseTo(18_000 * 32 / 1e6 + 1_800 * 64 / 1e6, 8)
    expect(costOf('gpt-realtime-2.1', { inputTokens: 1000, outputTokens: 0 })).toBe(0)
  })

  it('keeps every rate positive and output dearer than input', () => {
    for (const [model, r] of Object.entries({ ...MODEL_RATES, ...REALTIME_AUDIO_RATES })) {
      expect(r.inputPerMillion, model).toBeGreaterThan(0)
      expect(r.outputPerMillion, model).toBeGreaterThan(r.inputPerMillion)
      if (r.cachedInputPerMillion !== undefined) {
        expect(r.cachedInputPerMillion, model).toBeLessThan(r.inputPerMillion)
      }
    }
  })
})
