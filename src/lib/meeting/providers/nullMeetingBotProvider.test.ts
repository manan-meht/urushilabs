import { describe, it, expect } from 'vitest'
import { NullMeetingBotProvider } from './nullMeetingBotProvider'
import { MeetingProviderNotConfiguredError } from '../provider'

describe('NullMeetingBotProvider — dev/unconfigured environment (spec §13/§45)', () => {
  const provider = new NullMeetingBotProvider()

  it('reports itself as not configured', () => {
    expect(provider.isConfigured()).toBe(false)
  })

  it('never fakes a successful bot join', async () => {
    await expect(provider.createBot({
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      platform: 'google_meet',
      botDisplayName: 'Urushi — AI Mediator',
      idempotencyKey: 'session-1',
      webhookUrl: 'https://example.com/webhook',
    })).rejects.toThrow(MeetingProviderNotConfiguredError)
  })

  it('never fakes bot status, audio delivery, or participant data', async () => {
    await expect(provider.getBotStatus('bot-1')).rejects.toThrow(MeetingProviderNotConfiguredError)
    await expect(provider.sendChatMessage({ providerBotId: 'bot-1', message: 'hi' })).rejects.toThrow(MeetingProviderNotConfiguredError)
    await expect(provider.getParticipants('bot-1')).rejects.toThrow(MeetingProviderNotConfiguredError)
  })

  it('never verifies a webhook as authentic', () => {
    expect(provider.verifyWebhook({ rawBody: '{}', headers: {} })).toBe(false)
  })

  it('returns no events from handleWebhook', () => {
    expect(provider.handleWebhook('{}')).toEqual([])
  })
})
