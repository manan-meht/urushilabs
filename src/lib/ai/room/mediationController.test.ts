import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetEnv = vi.fn()
vi.mock('@/lib/env', () => ({ getEnv: () => mockGetEnv() }))

import { decideIntervention, type MediationContext } from './mediationController'
import { normalizeConversationSettings } from '@/lib/conversation/settings'

const baseCtx: MediationContext = {
  settings: normalizeConversationSettings({}),
  topic: 'Division of responsibilities',
  participantNames: ['Manan', 'Sonam'],
  recentTranscript: [],
  latestUtterance: { speakerName: 'Manan', content: 'I feel like I am carrying most of the work here.' },
  secondsSinceLastIntervention: 999,
}

function envWith(overrides: Partial<{ DEMO_MODE: boolean; OPENAI_API_KEY: string; OPENAI_MODEL: string }>) {
  mockGetEnv.mockReturnValue({
    DEMO_MODE: false,
    OPENAI_API_KEY: 'sk-test',
    OPENAI_MODEL: 'gpt-4o',
    ...overrides,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn())
})

describe('decideIntervention — trivial utterance fast path', () => {
  it('returns LISTEN without any network call for a bare acknowledgement', async () => {
    envWith({})
    const decision = await decideIntervention({ ...baseCtx, latestUtterance: { speakerName: 'Sonam', content: 'yes' } })
    expect(decision.action).toBe('LISTEN')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not treat a hostile utterance as a trivial acknowledgement', async () => {
    envWith({ DEMO_MODE: true })
    const decision = await decideIntervention({ ...baseCtx, latestUtterance: { speakerName: 'Sonam', content: 'You are pathetic.' } })
    // It still resolves to LISTEN here (demo mode), but via the demo branch's reasoning,
    // not the trivial-utterance fast path — confirming escalation-flavoured text isn't
    // silently swallowed by the "yes/no/right" shortcut.
    expect(decision.action).toBe('LISTEN')
    expect(decision.reasoning).toMatch(/demo mode/i)
  })
})

describe('decideIntervention — demo mode', () => {
  it('returns LISTEN without a network call', async () => {
    envWith({ DEMO_MODE: true })
    const decision = await decideIntervention(baseCtx)
    expect(decision.action).toBe('LISTEN')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('decideIntervention — missing API key', () => {
  it('throws when not in demo mode and no key is configured', async () => {
    envWith({ DEMO_MODE: false, OPENAI_API_KEY: '' })
    await expect(decideIntervention(baseCtx)).rejects.toThrow(/OPENAI_API_KEY/)
  })
})

describe('decideIntervention — live model call', () => {
  it('parses a valid decision from the model', async () => {
    envWith({})
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ action: 'CLARIFY', reasoning: 'Ambiguous claim.' }) } }],
      }),
    } as Response)

    const decision = await decideIntervention(baseCtx)
    expect(decision.action).toBe('CLARIFY')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('downgrades to LISTEN when the model proposes an intervention during the cooldown window', async () => {
    envWith({})
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ action: 'SUMMARIZE', reasoning: 'Recap so far.' }) } }],
      }),
    } as Response)

    const decision = await decideIntervention({ ...baseCtx, secondsSinceLastIntervention: 2 })
    expect(decision.action).toBe('LISTEN')
    expect(decision.reasoning).toMatch(/cooldown/i)
  })

  it('lets DEESCALATE through even during the cooldown window', async () => {
    envWith({})
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ action: 'DEESCALATE', reasoning: 'Tone is escalating.' }) } }],
      }),
    } as Response)

    const decision = await decideIntervention({ ...baseCtx, secondsSinceLastIntervention: 1 })
    expect(decision.action).toBe('DEESCALATE')
  })

  it('throws on a non-ok response', async () => {
    envWith({})
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' } as Response)
    await expect(decideIntervention(baseCtx)).rejects.toThrow(/mediation controller failed/i)
  })

  it('throws when the model response fails schema validation', async () => {
    envWith({})
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ action: 'NOT_A_REAL_ACTION' }) } }] }),
    } as Response)
    await expect(decideIntervention(baseCtx)).rejects.toThrow(/schema validation failed/i)
  })
})
