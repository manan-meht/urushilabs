import { describe, it, expect } from 'vitest'
import { completionParams, wasTruncated } from './modelParams'

describe('completionParams', () => {
  it('uses max_tokens and temperature for the older families', () => {
    expect(completionParams('gpt-4o', 400, 0.2)).toEqual({ max_tokens: 400, temperature: 0.2 })
  })

  it('uses max_completion_tokens and NO temperature for reasoning families', () => {
    // gpt-6-luna returns 400 for both `max_tokens` and any non-default
    // temperature. Sending either breaks the call outright.
    const p = completionParams('gpt-6-luna', 400, 0.2)
    expect(p.max_completion_tokens).toBeGreaterThan(0)
    expect(p.max_tokens).toBeUndefined()
    expect(p.temperature).toBeUndefined()
  })

  it('gives reasoning models far more headroom than the answer needs', () => {
    // Reasoning is drawn from the same budget before any content is emitted, so
    // a ceiling sized for the answer gets spent entirely on thinking and the
    // response comes back empty — observed live at 900 for a ~500-token answer.
    expect(completionParams('gpt-6-luna', 400).max_completion_tokens).toBeGreaterThanOrEqual(1500)
    expect(completionParams('gpt-6-luna', 2500).max_completion_tokens).toBeGreaterThanOrEqual(15000)
  })

  it('omits temperature when the caller did not ask for one', () => {
    expect(completionParams('gpt-4o', 400)).toEqual({ max_tokens: 400 })
  })

  it('covers the families this product actually uses or might switch to', () => {
    for (const m of ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'o1', 'o3']) {
      expect(completionParams(m, 400).max_completion_tokens, m).toBeDefined()
    }
    for (const m of ['gpt-4o', 'gpt-4o-mini']) {
      expect(completionParams(m, 400).max_tokens, m).toBe(400)
    }
  })
})

describe('wasTruncated', () => {
  it('recognises the token ceiling', () => {
    expect(wasTruncated('length')).toBe(true)
    expect(wasTruncated('stop')).toBe(false)
    expect(wasTruncated(undefined)).toBe(false)
  })
})
