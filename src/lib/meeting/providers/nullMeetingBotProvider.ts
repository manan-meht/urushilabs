/**
 * Graceful dev-environment provider used when no meeting-bot transport is
 * configured (spec §13/§45). The app must build and Meeting Mediation setup
 * must work end-to-end without Recall credentials; only an actual join attempt
 * should surface "not configured", and it must never fake a successful connection.
 */

import type {
  BotHandle,
  BotStatusResult,
  CreateBotParams,
  MeetingBotProvider,
  MeetingParticipantInfo,
  NormalizedProviderEvent,
  ScheduleBotParams,
  SendAudioParams,
  SendChatMessageParams,
  WebhookVerificationInput,
} from '../provider'
import { MeetingProviderNotConfiguredError } from '../provider'

export class NullMeetingBotProvider implements MeetingBotProvider {
  readonly name = 'recall' as const

  isConfigured(): boolean {
    return false
  }

  async createBot(_params: CreateBotParams): Promise<BotHandle> {
    throw new MeetingProviderNotConfiguredError('Recall')
  }

  async scheduleBot(_params: ScheduleBotParams): Promise<BotHandle> {
    throw new MeetingProviderNotConfiguredError('Recall')
  }

  async joinMeeting(_providerBotId: string): Promise<void> {
    throw new MeetingProviderNotConfiguredError('Recall')
  }

  async leaveMeeting(_providerBotId: string): Promise<void> {
    throw new MeetingProviderNotConfiguredError('Recall')
  }

  async getBotStatus(_providerBotId: string): Promise<BotStatusResult> {
    throw new MeetingProviderNotConfiguredError('Recall')
  }

  async sendAudio(_params: SendAudioParams): Promise<void> {
    throw new MeetingProviderNotConfiguredError('Recall')
  }

  async sendChatMessage(_params: SendChatMessageParams): Promise<void> {
    throw new MeetingProviderNotConfiguredError('Recall')
  }

  async getParticipants(_providerBotId: string): Promise<MeetingParticipantInfo[]> {
    throw new MeetingProviderNotConfiguredError('Recall')
  }

  verifyWebhook(_input: WebhookVerificationInput): boolean {
    return false
  }

  handleWebhook(_rawBody: string): NormalizedProviderEvent[] {
    return []
  }
}
