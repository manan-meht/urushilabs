import { describe, it, expect } from 'vitest'
import { detectMeetingPlatform, CreateMeetingSessionSchema, MeetingAgentSettingsSchema, UpdateMeetingDetailsSchema, MeetingConsentSchema } from './schemas'

describe('detectMeetingPlatform', () => {
  it('detects Google Meet links', () => {
    expect(detectMeetingPlatform('https://meet.google.com/abc-defg-hij')).toBe('google_meet')
  })

  it('detects Zoom links', () => {
    expect(detectMeetingPlatform('https://zoom.us/j/1234567890')).toBe('zoom')
    expect(detectMeetingPlatform('https://us02web.zoom.us/j/1234567890?pwd=abc')).toBe('zoom')
  })

  it('returns null for an invalid/unrelated URL (spec §7/§34)', () => {
    expect(detectMeetingPlatform('https://example.com/not-a-meeting')).toBeNull()
    expect(detectMeetingPlatform('not a url at all')).toBeNull()
  })
})

describe('CreateMeetingSessionSchema', () => {
  it('accepts 2 participants', () => {
    const result = CreateMeetingSessionSchema.safeParse({
      participants: [{ name: 'Manan', email: 'manan@example.com' }, { name: 'Sonam', email: 'sonam@example.com' }],
      topic: 'How responsibilities are divided',
    })
    expect(result.success).toBe(true)
  })

  it('accepts 3 participants', () => {
    const result = CreateMeetingSessionSchema.safeParse({
      participants: [
        { name: 'Manan', email: 'manan@example.com' },
        { name: 'Sonam', email: 'sonam@example.com' },
        { name: 'Priya', email: 'priya@example.com' },
      ],
      topic: 'How responsibilities are divided',
    })
    expect(result.success).toBe(true)
  })

  it('rejects 1 participant', () => {
    const result = CreateMeetingSessionSchema.safeParse({
      participants: [{ name: 'Manan', email: 'manan@example.com' }],
      topic: 'How responsibilities are divided',
    })
    expect(result.success).toBe(false)
  })

  it('rejects 4 participants', () => {
    const result = CreateMeetingSessionSchema.safeParse({
      participants: Array.from({ length: 4 }, (_, i) => ({ name: `P${i}`, email: `p${i}@example.com` })),
      topic: 'How responsibilities are divided',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid participant email', () => {
    const result = CreateMeetingSessionSchema.safeParse({
      participants: [{ name: 'Manan', email: 'not-an-email' }, { name: 'Sonam', email: 'sonam@example.com' }],
      topic: 'How responsibilities are divided',
    })
    expect(result.success).toBe(false)
  })
})

describe('MeetingAgentSettingsSchema', () => {
  it('accepts the three meeting-owned axes', () => {
    const result = MeetingAgentSettingsSchema.safeParse({
      voiceGender: 'male',
      region: 'indian',
      interventionLevel: 'chair',
    })
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual({
      voiceGender: 'male',
      region: 'indian',
      interventionLevel: 'chair',
    })
  })

  it('strips personality, language and languageStyle from a stale client', () => {
    // These are agreed once for the whole conversation and arrive as
    // `conversationSettings`. Accepting them here too is what let a meeting run
    // as one personality and be written up as another — an old client is not an
    // error, but its meeting-side copy must not survive parsing.
    const result = MeetingAgentSettingsSchema.safeParse({
      personality: 'straight_shooter',
      language: 'hindi',
      languageStyle: 'unfiltered',
      region: 'indian',
    })
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual({ region: 'indian' })
  })
})

describe('UpdateMeetingDetailsSchema', () => {
  it('rejects an invalid meeting URL', () => {
    const result = UpdateMeetingDetailsSchema.safeParse({ meetingUrl: 'https://example.com/foo', startNow: true })
    expect(result.success).toBe(false)
  })

  it('accepts a valid Zoom link with start now', () => {
    const result = UpdateMeetingDetailsSchema.safeParse({ meetingUrl: 'https://zoom.us/j/1234567890', startNow: true })
    expect(result.success).toBe(true)
  })
})

describe('MeetingConsentSchema', () => {
  it('requires every consent field to be explicitly true (spec §11)', () => {
    const result = MeetingConsentSchema.safeParse({
      confirmedAiMediator: true,
      confirmedListeningAndProcessing: true,
      confirmedMaySpeak: true,
      confirmedVoluntary: false,
    })
    expect(result.success).toBe(false)
  })

  it('accepts when all four are true', () => {
    const result = MeetingConsentSchema.safeParse({
      confirmedAiMediator: true,
      confirmedListeningAndProcessing: true,
      confirmedMaySpeak: true,
      confirmedVoluntary: true,
    })
    expect(result.success).toBe(true)
  })
})
