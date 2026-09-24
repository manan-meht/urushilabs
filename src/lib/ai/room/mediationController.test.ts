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
    const { decision } = await decideIntervention({ ...baseCtx, latestUtterance: { speakerName: 'Sonam', content: 'yes' } })
    expect(decision.action).toBe('LISTEN')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not treat a hostile utterance as a trivial acknowledgement', async () => {
    envWith({ DEMO_MODE: true })
    const { decision } = await decideIntervention({ ...baseCtx, latestUtterance: { speakerName: 'Sonam', content: 'You are pathetic.' } })
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
    const { decision } = await decideIntervention(baseCtx)
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

    const { decision } = await decideIntervention(baseCtx)
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

    const { decision } = await decideIntervention({ ...baseCtx, secondsSinceLastIntervention: 2 })
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

    const { decision } = await decideIntervention({ ...baseCtx, secondsSinceLastIntervention: 1 })
    expect(decision.action).toBe('DEESCALATE')
  })

  it('throws on a non-ok response that does not clear on retry', async () => {
    envWith({})
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' } as Response)
    await expect(decideIntervention(baseCtx)).rejects.toThrow(/mediation controller failed/i)
  })

  it('retries a rate limit rather than losing the turn', async () => {
    // A 429 used to throw straight out, which surfaces as a 500 and drops the
    // mediator's reply while the participant's words are already saved. Silence
    // is this system's failure mode for everything, so a lost turn is
    // indistinguishable from a deliberate decision to listen — the room just
    // waits. Observed repeatedly once the prompt grew: the token-per-minute
    // ceiling is reachable in a normal conversation.
    envWith({})
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => '0' },
        text: async () => 'rate limited',
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ action: 'CLARIFY', reasoning: 'Worth a question.' }) } }],
        }),
      } as Response)

    const { decision } = await decideIntervention(baseCtx)
    expect(decision.action).toBe('CLARIFY')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry a bad request, which will fail identically', async () => {
    envWith({})
    vi.mocked(fetch).mockResolvedValue({
      ok: false, status: 400, headers: { get: () => null }, text: async () => 'bad request',
    } as unknown as Response)
    await expect(decideIntervention(baseCtx)).rejects.toThrow(/400/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('accepts null for optional fields, which is what the model actually sends', async () => {
    // The model does not omit a field it has nothing to say for, it sends null.
    // .optional() rejects null, so a perfectly reasonable response failed schema
    // validation and the mediator went silent for that turn.
    envWith({})
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          action: 'LISTEN', reasoning: 'Let them talk.', spokenText: null,
          currentIssueTitle: null, emergingAgreement: null,
        }) } }],
      }),
    } as Response)

    const { decision } = await decideIntervention(baseCtx)
    expect(decision.action).toBe('LISTEN')
    expect(decision.emergingAgreement).toBeUndefined()
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
