import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetEnv = vi.fn()
vi.mock('@/lib/env', () => ({ getEnv: () => mockGetEnv() }))

import { generateRoomFinalReport, type RoomFinalReportContext } from './finalReport'

const ctx: RoomFinalReportContext = {
  topic: 'Division of responsibilities',
  participantNames: ['Manan', 'Sonam'],
  conversationSummary: 'They discussed how tasks get assigned and agreed to check in weekly.',
  issueResolutions: [{ title: 'Workload split', status: 'agreed', resolution: 'Rotate weekly.' }],
  confirmedAgreements: ['Routine decisions can be made independently.'],
  transcriptExcerpt: [{ speakerName: 'Manan', content: 'I feel like I carry most of the work.' }],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn())
})

describe('generateRoomFinalReport — demo mode', () => {
  it('returns a well-formed canned report without any network call', async () => {
    mockGetEnv.mockReturnValue({ DEMO_MODE: true, OPENAI_API_KEY: '', OPENAI_MODEL: 'gpt-4o' })

    const result = await generateRoomFinalReport(ctx)

    expect(fetch).not.toHaveBeenCalled()
    expect(result.report.whatHappened.length).toBeGreaterThan(0)
    expect(result.report.agreed.length).toBeGreaterThan(0)
    expect(result.report.participantActions).toHaveLength(2)
    expect(result.report.participantActions.map((a) => a.participantName)).toEqual(['Manan', 'Sonam'])
    expect(result.report.safetyCategory).toBe('ordinary_conflict')
  })
})

describe('generateRoomFinalReport — live model call', () => {
  it('throws when no API key is configured outside demo mode', async () => {
    mockGetEnv.mockReturnValue({ DEMO_MODE: false, OPENAI_API_KEY: '', OPENAI_MODEL: 'gpt-4o' })
    await expect(generateRoomFinalReport(ctx)).rejects.toThrow(/OPENAI_API_KEY/)
  })

  it('parses a valid model response', async () => {
    mockGetEnv.mockReturnValue({ DEMO_MODE: false, OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-4o' })
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              whatHappened: 'A calm, productive conversation.',
              agreed: [{ title: 'Workload split', description: 'Rotate weekly.' }],
              unresolved: [],
              participantActions: [
                { participantName: 'Manan', actions: ['Follow the new rotation.'] },
                { participantName: 'Sonam', actions: ['Flag urgent items clearly.'] },
              ],
              nextSteps: ['Check in next week.'],
              safetyCategory: 'ordinary_conflict',
            }),
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    } as Response)

    const result = await generateRoomFinalReport(ctx)
    expect(result.report.whatHappened).toBe('A calm, productive conversation.')
    expect(result.inputTokens).toBe(10)
    expect(result.outputTokens).toBe(20)
  })

  it('throws when the model response fails schema validation', async () => {
    mockGetEnv.mockReturnValue({ DEMO_MODE: false, OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-4o' })
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ whatHappened: 'ok' }) } }] }),
    } as Response)
    await expect(generateRoomFinalReport(ctx)).rejects.toThrow(/schema validation failed/i)
  })
})
