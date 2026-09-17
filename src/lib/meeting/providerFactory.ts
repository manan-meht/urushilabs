import { isRecallConfigured } from '@/lib/featureFlags'
import type { MeetingBotProvider } from './provider'
import { RecallMeetingBotProvider } from './providers/recallProvider'
import { NullMeetingBotProvider } from './providers/nullMeetingBotProvider'

/**
 * Returns the active meeting-bot transport provider. Today this is always Recall
 * (configured or not) — a future NativeZoomMeetingProvider/NativeGoogleMeetProvider
 * would be selected here too, without any caller needing to change.
 */
export function getMeetingBotProvider(): MeetingBotProvider {
  return isRecallConfigured() ? new RecallMeetingBotProvider() : new NullMeetingBotProvider()
}
