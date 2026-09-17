import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetEnv = vi.fn()
vi.mock('@/lib/env', () => ({ getEnv: () => mockGetEnv() }))

import { generateMeetingFinalReport, type MeetingFinalReportContext } from './finalReport'

const ctx: MeetingFinalReportContext = {
  topic: 'Division of business responsibilities',
  participantNames: ['Manan', 'Sonam'],
  conversationSummary: 'They discussed how decisions get made and agreed on a response-time rule.',
  issueResolutions: [{ title: 'Response times', status: 'agreed', resolution: 'Reply within 24 hours on business days.' }],
  confirmedAgreements: ['Non-urgent requests get a 24-hour response window.'],
  transcriptExcerpt: [{ speakerName: 'Manan', content: 'I feel like I am doing most of the work.' }],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn())
})

describe('generateMeetingFinalReport — demo mode', () => {
  it('returns a well-formed canned report without any network call', async () => {
    mockGetEnv.mockReturnValue({ DEMO_MODE: true, OPENAI_API_KEY: '', OPENAI_MODEL: 'gpt-4o' })

    const result = await generateMeetingFinalReport(ctx)

    expect(fetch).not.toHaveBeenCalled()
    expect(result.report.whatHappened.length).toBeGreaterThan(0)
    expect(result.report.participantActions).toHaveLength(2)
    expect(result.report.safetyCategory).toBe('ordinary_conflict')
  })
})

describe('generateMeetingFinalReport — live model call', () => {
  it('throws when no API key is configured outside demo mode', async () => {
    mockGetEnv.mockReturnValue({ DEMO_MODE: false, OPENAI_API_KEY: '', OPENAI_MODEL: 'gpt-4o' })
    await expect(generateMeetingFinalReport(ctx)).rejects.toThrow(/OPENAI_API_KEY/)
  })

  it('parses a valid report from the model', async () => {
    mockGetEnv.mockReturnValue({ DEMO_MODE: false, OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-4o' })
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              whatHappened: 'They discussed workload distribution and reached a partial agreement.',
              agreed: [{ title: 'Response times', description: 'Reply within 24 hours.' }],
              unresolved: [],
              participantActions: [
                { participantName: 'Manan', actions: ['Send fewer urgent-flagged requests.'] },
                { participantName: 'Sonam', actions: ['Confirm receipt within a day.'] },
              ],
              nextSteps: ['Check in after two weeks.'],
              safetyCategory: 'ordinary_conflict',
            }),
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    } as Response)

    const result = await generateMeetingFinalReport(ctx)
    expect(result.report.agreed[0]!.title).toBe('Response times')
    expect(result.inputTokens).toBe(100)
    expect(result.outputTokens).toBe(50)
  })

  it('throws on a non-ok response', async () => {
    mockGetEnv.mockReturnValue({ DEMO_MODE: false, OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-4o' })
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' } as Response)
    await expect(generateMeetingFinalReport(ctx)).rejects.toThrow(/meeting final report failed/i)
  })
})
