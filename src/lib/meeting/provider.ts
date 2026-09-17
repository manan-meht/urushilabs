/**
 * MeetingBotProvider — the transport abstraction between Urushi's mediation engine
 * and whatever gets a bot into a Google Meet/Zoom call. Recall.ai is today's
 * implementation (see ./providers/recallProvider.ts), but nothing above this
 * interface should ever import from a Recall-specific module or know a Recall
 * bot ID exists. This is what lets Urushi later add NativeZoomMeetingProvider,
 * NativeGoogleMeetProvider, or swap transport vendors without touching the
 * mediation controller, API routes, or UI.
 *
 * Server-only. Never import from client components.
 */

import type { MeetingPlatform } from '@/lib/db/types'

export interface CreateBotParams {
  meetingUrl: string
  platform: MeetingPlatform
  botDisplayName: string
  /** Idempotency key — must be stable for retries of the same logical join request. */
  idempotencyKey: string
  /** Where the provider should send webhook events for this bot. */
  webhookUrl: string
}

export interface ScheduleBotParams extends CreateBotParams {
  joinAt: string // ISO timestamp
}

export interface BotHandle {
  providerBotId: string
  providerMeetingId?: string
}

export type ProviderBotStatus =
  | 'joining'
  | 'waiting_room'
  | 'in_meeting'
  | 'ended'
  | 'error'
  | 'removed'

export interface BotStatusResult {
  status: ProviderBotStatus
  raw?: Record<string, unknown>
}

export interface SendAudioParams {
  providerBotId: string
  /** Raw audio bytes (format is provider-specific — see provider implementation notes). */
  audio: ArrayBuffer
  mimeType: string
}

export interface SendChatMessageParams {
  providerBotId: string
  message: string
}

export interface MeetingParticipantInfo {
  providerParticipantId: string
  displayName: string | null
}

// ─── Normalized webhook events ─────────────────────────────────────────────────
// Every provider implementation must translate its own webhook payload shape into
// one of these before handing it to the mediation layer — see spec §15/§17.

export type MeetingProviderEventType =
  | 'bot_created'
  | 'bot_joining'
  | 'bot_waiting_room'
  | 'bot_admitted'
  | 'participant_joined'
  | 'participant_left'
  | 'transcript_segment'
  | 'speaker_identified'
  | 'meeting_ended'
  | 'bot_removed'
  | 'bot_error'
  | 'recording_event'

export interface NormalizedTranscriptSegment {
  providerParticipantId: string | null
  speakerName: string | null
  text: string
  startedAt: string | null
  endedAt: string | null
  confidence: number | null
}

export interface NormalizedProviderEvent {
  type: MeetingProviderEventType
  providerBotId: string
  providerEventId: string
  occurredAt: string
  transcriptSegment?: NormalizedTranscriptSegment
  participant?: MeetingParticipantInfo
  errorMessage?: string
  raw: Record<string, unknown>
}

export interface WebhookVerificationInput {
  rawBody: string
  headers: Record<string, string | null>
}

/**
 * The provider-agnostic contract the mediation engine and API routes depend on.
 * Implementations must never throw for "not configured" — see NullMeetingBotProvider
 * for the graceful dev-environment behavior (spec §13/§45).
 */
export interface MeetingBotProvider {
  readonly name: 'recall'
  isConfigured(): boolean

  createBot(params: CreateBotParams): Promise<BotHandle>
  scheduleBot(params: ScheduleBotParams): Promise<BotHandle>
  joinMeeting(providerBotId: string): Promise<void>
  leaveMeeting(providerBotId: string): Promise<void>
  getBotStatus(providerBotId: string): Promise<BotStatusResult>
  sendAudio(params: SendAudioParams): Promise<void>
  sendChatMessage(params: SendChatMessageParams): Promise<void>
  getParticipants(providerBotId: string): Promise<MeetingParticipantInfo[]>

  /** Verifies webhook authenticity per the provider's documented signing mechanism. */
  verifyWebhook(input: WebhookVerificationInput): boolean
  /** Parses an already-verified webhook payload into normalized event(s). */
  handleWebhook(rawBody: string): NormalizedProviderEvent[]
}

/** Thrown by provider methods (other than isConfigured/verifyWebhook) when credentials are absent. */
export class MeetingProviderNotConfiguredError extends Error {
  constructor(providerName: string) {
    super(`${providerName} is not configured in this environment.`)
    this.name = 'MeetingProviderNotConfiguredError'
  }
}
