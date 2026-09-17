import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'

const mockGetEnv = vi.fn()
vi.mock('@/lib/env', () => ({ getEnv: () => mockGetEnv() }))

import { RecallMeetingBotProvider } from './recallProvider'

const SECRET_B64 = Buffer.from('test-signing-key-32-bytes-long!!').toString('base64')

function envWith(overrides: Partial<{ RECALL_API_KEY: string; RECALL_WEBHOOK_SECRET: string; RECALL_API_BASE_URL: string; RECALL_BOT_NAME: string }> = {}) {
  mockGetEnv.mockReturnValue({
    RECALL_API_KEY: 'test-key',
    RECALL_WEBHOOK_SECRET: `whsec_${SECRET_B64}`,
    RECALL_API_BASE_URL: 'https://us-east-1.recall.ai/api/v1',
    RECALL_BOT_NAME: 'Urushi — AI Mediator',
    ...overrides,
  })
}

function signPayload(id: string, timestamp: string, rawBody: string, secretB64 = SECRET_B64): string {
  const key = Buffer.from(secretB64, 'base64')
  const signedContent = `${id}.${timestamp}.${rawBody}`
  const sig = createHmac('sha256', key).update(signedContent).digest('base64')
  return `v1,${sig}`
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('RecallMeetingBotProvider.isConfigured', () => {
  it('is false without an API key', () => {
    envWith({ RECALL_API_KEY: '' })
    expect(new RecallMeetingBotProvider().isConfigured()).toBe(false)
  })

  it('is true with an API key', () => {
    envWith()
    expect(new RecallMeetingBotProvider().isConfigured()).toBe(true)
  })
})

describe('RecallMeetingBotProvider.verifyWebhook', () => {
  it('accepts a correctly signed payload', () => {
    envWith()
    const provider = new RecallMeetingBotProvider()
    const rawBody = JSON.stringify({ event: 'bot.status_change' })
    const id = 'msg_1'
    const timestamp = '1700000000'
    const signature = signPayload(id, timestamp, rawBody)

    expect(provider.verifyWebhook({
      rawBody,
      headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature },
    })).toBe(true)
  })

  it('rejects a tampered body', () => {
    envWith()
    const provider = new RecallMeetingBotProvider()
    const id = 'msg_1'
    const timestamp = '1700000000'
    const signature = signPayload(id, timestamp, JSON.stringify({ event: 'bot.status_change' }))

    expect(provider.verifyWebhook({
      rawBody: JSON.stringify({ event: 'bot.fatal' }),
      headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature },
    })).toBe(false)
  })

  it('rejects when headers are missing', () => {
    envWith()
    const provider = new RecallMeetingBotProvider()
    expect(provider.verifyWebhook({ rawBody: '{}', headers: {} })).toBe(false)
  })

  it('rejects when no webhook secret is configured', () => {
    envWith({ RECALL_WEBHOOK_SECRET: '' })
    const provider = new RecallMeetingBotProvider()
    expect(provider.verifyWebhook({ rawBody: '{}', headers: { 'webhook-id': 'a', 'webhook-timestamp': 'b', 'webhook-signature': 'v1,x' } })).toBe(false)
  })
})

describe('RecallMeetingBotProvider.handleWebhook — normalization', () => {
  it('maps a bot.status_change in_call_recording event to bot_admitted', () => {
    envWith()
    const provider = new RecallMeetingBotProvider()
    const events = provider.handleWebhook(JSON.stringify({
      event: 'bot.status_change',
      id: 'evt_1',
      data: { bot: { id: 'bot_123' }, data: { code: 'in_call_recording', updated_at: '2026-01-01T00:00:00Z' } },
    }))
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('bot_admitted')
    expect(events[0]!.providerBotId).toBe('bot_123')
  })

  it('maps a bot.status_change call_ended event to meeting_ended', () => {
    envWith()
    const provider = new RecallMeetingBotProvider()
    const events = provider.handleWebhook(JSON.stringify({
      event: 'bot.status_change',
      id: 'evt_2',
      data: { bot: { id: 'bot_123' }, data: { code: 'call_ended', updated_at: '2026-01-01T00:00:00Z' } },
    }))
    expect(events[0]!.type).toBe('meeting_ended')
  })

  it('maps a bot.status_change fatal event to bot_error with an error message', () => {
    envWith()
    const provider = new RecallMeetingBotProvider()
    const events = provider.handleWebhook(JSON.stringify({
      event: 'bot.status_change',
      id: 'evt_3',
      data: { bot: { id: 'bot_123' }, data: { code: 'fatal', sub_code: 'meeting_not_found', updated_at: '2026-01-01T00:00:00Z' } },
    }))
    expect(events[0]!.type).toBe('bot_error')
    expect(events[0]!.errorMessage).toBe('meeting_not_found')
  })

  // The payload shapes below are copied from real Recall deliveries captured off
  // the production webhook — they differ from the OpenAPI-inferred shape this
  // provider was originally written against: transcript/participant data sits at
  // data.data.*, words carry {relative, absolute} timestamps, and there is no
  // top-level `transcript.text`.
  it('maps a transcript.data event to a normalized transcript segment', () => {
    envWith()
    const provider = new RecallMeetingBotProvider()
    const events = provider.handleWebhook(JSON.stringify({
      event: 'transcript.data',
      id: 'evt_4',
      data: {
        bot: { id: 'bot_123' },
        data: {
          words: [
            { text: 'We need a', start_timestamp: { absolute: '2026-01-01T00:00:10Z' }, end_timestamp: { absolute: '2026-01-01T00:00:11Z' } },
            { text: 'response-time rule.', start_timestamp: { absolute: '2026-01-01T00:00:11Z' }, end_timestamp: { absolute: '2026-01-01T00:00:12Z' } },
          ],
          participant: { id: 42, name: 'Sonam' },
        },
      },
    }))
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('transcript_segment')
    expect(events[0]!.transcriptSegment?.text).toBe('We need a response-time rule.')
    expect(events[0]!.transcriptSegment?.speakerName).toBe('Sonam')
    expect(events[0]!.transcriptSegment?.providerParticipantId).toBe('42')
    expect(events[0]!.transcriptSegment?.startedAt).toBe('2026-01-01T00:00:10Z')
  })

  it('maps participant_events.join/leave to normalized participant events', () => {
    envWith()
    const provider = new RecallMeetingBotProvider()
    const joined = provider.handleWebhook(JSON.stringify({
      event: 'participant_events.join',
      id: 'evt_5',
      data: { bot: { id: 'bot_123' }, data: { participant: { id: 42, name: 'Sonam' } } },
    }))
    expect(joined[0]!.type).toBe('participant_joined')
    expect(joined[0]!.participant?.displayName).toBe('Sonam')
    expect(joined[0]!.participant?.providerParticipantId).toBe('42')
  })

  it('maps real per-code status events (bot.<code>, not bot.status_change)', () => {
    envWith()
    const provider = new RecallMeetingBotProvider()
    const events = provider.handleWebhook(JSON.stringify({
      event: 'bot.in_call_recording',
      data: {
        bot: { id: 'bot_123' },
        data: { code: 'in_call_recording', sub_code: null, updated_at: '2026-01-01T00:00:00Z' },
      },
    }))
    expect(events[0]!.type).toBe('bot_admitted')
  })

  it('returns no events for malformed JSON', () => {
    envWith()
    const provider = new RecallMeetingBotProvider()
    expect(provider.handleWebhook('not json')).toEqual([])
  })

  it('returns no events when bot id is missing', () => {
    envWith()
    const provider = new RecallMeetingBotProvider()
    expect(provider.handleWebhook(JSON.stringify({ event: 'bot.status_change', data: { data: { code: 'joining_call' } } }))).toEqual([])
  })
})
