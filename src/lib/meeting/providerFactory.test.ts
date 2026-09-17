import { describe, it, expect, vi } from 'vitest'

const mockIsRecallConfigured = vi.fn()
vi.mock('@/lib/featureFlags', () => ({ isRecallConfigured: () => mockIsRecallConfigured() }))

import { getMeetingBotProvider } from './providerFactory'
import { RecallMeetingBotProvider } from './providers/recallProvider'
import { NullMeetingBotProvider } from './providers/nullMeetingBotProvider'

describe('getMeetingBotProvider', () => {
  it('returns the Recall provider when configured', () => {
    mockIsRecallConfigured.mockReturnValue(true)
    expect(getMeetingBotProvider()).toBeInstanceOf(RecallMeetingBotProvider)
  })

  it('returns the graceful null provider when Recall credentials are absent (spec §13/§45)', () => {
    mockIsRecallConfigured.mockReturnValue(false)
    expect(getMeetingBotProvider()).toBeInstanceOf(NullMeetingBotProvider)
  })
})
