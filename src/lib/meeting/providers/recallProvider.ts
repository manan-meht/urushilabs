/**
 * Recall.ai implementation of MeetingBotProvider. This is the ONLY file in Urushi
 * that should know Recall-specific endpoint paths, payload shapes, or webhook
 * event names — everything above `../provider.ts`'s interface is transport-agnostic.
 *
 * Verified against Recall's current docs (docs.recall.ai) while implementing:
 *   - Regions/base URLs: docs.recall.ai/docs/regions
 *   - Create bot:        docs.recall.ai/reference/bot_create  (POST /api/v1/bot/)
 *   - Bot status events:  docs.recall.ai/docs/bot-status-change-events
 *       Account-level webhook event "bot.status_change" (via dashboard-configured
 *       webhook), with data.data.code holding the specific status
 *       (joining_call, in_waiting_room, in_call_not_recording, in_call_recording,
 *       recording_permission_allowed/denied, call_ended, done, fatal, breakout_room_*).
 *   - Real-time events:   docs.recall.ai/docs/real-time-webhook-endpoints
 *       Per-bot webhook (configured via `recording_config.realtime_endpoints` on bot
 *       creation) delivering transcript.data / transcript.partial_data /
 *       participant_events.join / participant_events.leave / etc. to the SAME
 *       webhook URL we register at the account level.
 *   - Webhook verification: docs.recall.ai/docs/authenticating-requests-from-recallai
 *       Headers `webhook-id` / `webhook-timestamp` / `webhook-signature` (Svix-
 *       compatible scheme), secret prefixed `whsec_`, HMAC-SHA256 over
 *       `{id}.{timestamp}.{rawBody}`, signature header may contain multiple
 *       space-separated `v1,<base64sig>` values (key rotation).
 *   - Output audio:       docs.recall.ai/docs/output-audio-in-meetings
 *       POST /api/v1/bot/{id}/output_audio/ — { kind: 'mp3', b64_data } — triggers a
 *       pre-rendered clip, NOT arbitrary real-time streaming. Requires
 *       `automatic_audio_output` configured at bot-creation time.
 *
 * NOT independently confirmed at implementation time — re-verify against the
 * Recall dashboard/docs for your account before relying on these in production:
 *   - Exact request/response shape of POST /api/v1/bot/{id}/output_media/ (the
 *     endpoint docs describe for realtime back-and-forth agent audio — this is
 *     the one Urushi's barge-in/interruption design (spec §23) actually wants,
 *     since output_audio is clip-trigger only).
 *   - Exact endpoint for leaving a call vs. deleting the bot resource entirely
 *     (implemented here as POST /bot/{id}/leave_call/ — confirm this is current).
 *   - Exact shape of a participants list endpoint/field (implemented here by
 *     reading `raw.data.participants` off the bot status response — confirm).
 *   - Exact Authorization header format (implemented as `Authorization: Token
 *     <key>`, inferred from the OpenAPI `tokenAuth` security scheme name, which
 *     is the Django REST Framework TokenAuthentication convention — confirm
 *     against a live account before going live).
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { getEnv } from '@/lib/env'
import type {
  BotHandle,
  BotStatusResult,
  CreateBotParams,
  MeetingBotProvider,
  MeetingParticipantInfo,
  MeetingProviderEventType,
  NormalizedProviderEvent,
  ProviderBotStatus,
  ScheduleBotParams,
  SendAudioParams,
  SendChatMessageParams,
  WebhookVerificationInput,
} from '../provider'
import { MeetingProviderNotConfiguredError } from '../provider'

const REALTIME_EVENTS = [
  'transcript.data',
  'transcript.partial_data',
  'participant_events.join',
  'participant_events.leave',
  'participant_events.speech_on',
  'participant_events.speech_off',
] as const

const STATUS_CODE_MAP: Record<string, ProviderBotStatus> = {
  joining_call: 'joining',
  in_waiting_room: 'waiting_room',
  in_call_not_recording: 'in_meeting',
  recording_permission_allowed: 'in_meeting',
  recording_permission_denied: 'in_meeting',
  in_call_recording: 'in_meeting',
  call_ended: 'ended',
  done: 'ended',
  fatal: 'error',
}

export class RecallMeetingBotProvider implements MeetingBotProvider {
  readonly name = 'recall' as const

  isConfigured(): boolean {
    return Boolean(getEnv().RECALL_API_KEY)
  }

  private baseUrl(): string {
    return getEnv().RECALL_API_BASE_URL.replace(/\/$/, '')
  }

  private headers(): Record<string, string> {
    const { RECALL_API_KEY } = getEnv()
    if (!RECALL_API_KEY) throw new MeetingProviderNotConfiguredError('Recall')
    return {
      // See module comment — verify this against a live Recall account.
      Authorization: `Token ${RECALL_API_KEY}`,
      'Content-Type': 'application/json',
    }
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) throw new MeetingProviderNotConfiguredError('Recall')
  }

  async createBot(params: CreateBotParams): Promise<BotHandle> {
    this.assertConfigured()
    const { RECALL_BOT_NAME } = getEnv()

    const res = await fetch(`${this.baseUrl()}/bot/`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        meeting_url: params.meetingUrl,
        bot_name: params.botDisplayName || RECALL_BOT_NAME,
        recording_config: {
          transcript: { provider: { meeting_captions: {} } },
          realtime_endpoints: [
            { type: 'webhook', url: params.webhookUrl, events: REALTIME_EVENTS },
          ],
        },
        metadata: { idempotency_key: params.idempotencyKey },
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Recall createBot failed (${res.status}): ${text}`)
    }

    const data = await res.json() as { id: string; meeting_url?: { meeting_id?: string } }
    return { providerBotId: data.id, providerMeetingId: data.meeting_url?.meeting_id }
  }

  async scheduleBot(params: ScheduleBotParams): Promise<BotHandle> {
    this.assertConfigured()
    const { RECALL_BOT_NAME } = getEnv()

    const res = await fetch(`${this.baseUrl()}/bot/`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        meeting_url: params.meetingUrl,
        bot_name: params.botDisplayName || RECALL_BOT_NAME,
        join_at: params.joinAt,
        recording_config: {
          transcript: { provider: { meeting_captions: {} } },
          realtime_endpoints: [
            { type: 'webhook', url: params.webhookUrl, events: REALTIME_EVENTS },
          ],
        },
        metadata: { idempotency_key: params.idempotencyKey },
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Recall scheduleBot failed (${res.status}): ${text}`)
    }

    const data = await res.json() as { id: string; meeting_url?: { meeting_id?: string } }
    return { providerBotId: data.id, providerMeetingId: data.meeting_url?.meeting_id }
  }

  async joinMeeting(): Promise<void> {
    // No-op: Recall bots join automatically once created (or at join_at for scheduled
    // bots) — there is no separate "join" call in the Bot API.
  }

  async leaveMeeting(providerBotId: string): Promise<void> {
    this.assertConfigured()
    const res = await fetch(`${this.baseUrl()}/bot/${providerBotId}/leave_call/`, {
      method: 'POST',
      headers: this.headers(),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Recall leaveMeeting failed (${res.status}): ${text}`)
    }
  }

  async getBotStatus(providerBotId: string): Promise<BotStatusResult> {
    this.assertConfigured()
    const res = await fetch(`${this.baseUrl()}/bot/${providerBotId}/`, {
      method: 'GET',
      headers: this.headers(),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Recall getBotStatus failed (${res.status}): ${text}`)
    }
    const raw = await res.json() as { status_changes?: Array<{ code?: string }> }
    const latestCode = raw.status_changes?.[raw.status_changes.length - 1]?.code
    return { status: (latestCode ? STATUS_CODE_MAP[latestCode] : undefined) ?? 'joining', raw }
  }

  async sendAudio(params: SendAudioParams): Promise<void> {
    this.assertConfigured()
    const base64 = Buffer.from(params.audio).toString('base64')
    const kind = params.mimeType.includes('mp3') || params.mimeType.includes('mpeg') ? 'mp3' : 'mp3'

    // Uses the clip-trigger output_audio endpoint. Urushi's interventions are short
    // (1-3 sentences), so per-utterance clip triggering fits — but see module
    // comment: output_media is Recall's documented path for lower-latency
    // conversational/barge-in audio and should be reassessed once real credentials
    // are available and barge-in (spec §23) is implemented.
    const res = await fetch(`${this.baseUrl()}/bot/${params.providerBotId}/output_audio/`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ kind, b64_data: base64 }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Recall sendAudio failed (${res.status}): ${text}`)
    }
  }

  async sendChatMessage(params: SendChatMessageParams): Promise<void> {
    this.assertConfigured()
    const res = await fetch(`${this.baseUrl()}/bot/${params.providerBotId}/send_chat_message/`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ message: params.message }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Recall sendChatMessage failed (${res.status}): ${text}`)
    }
  }

  async getParticipants(providerBotId: string): Promise<MeetingParticipantInfo[]> {
    this.assertConfigured()
    const status = await this.getBotStatus(providerBotId)
    const participants = (status.raw as { data?: { participants?: Array<{ id?: string; name?: string }> } })
      ?.data?.participants ?? []
    return participants
      .filter((p): p is { id: string; name?: string } => typeof p.id === 'string')
      .map((p) => ({ providerParticipantId: p.id, displayName: p.name ?? null }))
  }

  verifyWebhook(input: WebhookVerificationInput): boolean {
    const { RECALL_WEBHOOK_SECRET } = getEnv()
    if (!RECALL_WEBHOOK_SECRET) return false

    const id = input.headers['webhook-id'] ?? input.headers['svix-id']
    const timestamp = input.headers['webhook-timestamp'] ?? input.headers['svix-timestamp']
    const signatureHeader = input.headers['webhook-signature'] ?? input.headers['svix-signature']
    if (!id || !timestamp || !signatureHeader) return false

    const secretB64 = RECALL_WEBHOOK_SECRET.startsWith('whsec_')
      ? RECALL_WEBHOOK_SECRET.slice('whsec_'.length)
      : RECALL_WEBHOOK_SECRET
    const key = Buffer.from(secretB64, 'base64')

    const signedContent = `${id}.${timestamp}.${input.rawBody}`
    const expected = createHmac('sha256', key).update(signedContent).digest('base64')

    // Header may contain multiple space-separated "v1,<sig>" pairs (key rotation).
    return signatureHeader.split(' ').some((entry) => {
      const [, sig] = entry.split(',')
      if (!sig) return false
      try {
        const a = Buffer.from(sig, 'base64')
        const b = Buffer.from(expected, 'base64')
        return a.length === b.length && timingSafeEqual(a, b)
      } catch {
        return false
      }
    })
  }

  handleWebhook(rawBody: string): NormalizedProviderEvent[] {
    let json: unknown
    try {
      json = JSON.parse(rawBody)
    } catch {
      return []
    }

    // Real Recall payloads (verified against a live account — differs from the
    // OpenAPI-inferred shape originally implemented here):
    //   - Status events are named `bot.<code>` directly (e.g. "bot.joining_call",
    //     "bot.done"), NOT a generic "bot.status_change" wrapper.
    //   - Transcript/participant data sits at `data.data.*`, one level deeper than
    //     `data.*` — e.g. `data.data.words`, `data.data.participant`.
    //   - Word timestamps are `{ relative, absolute }` objects; `absolute` is
    //     already an ISO string.
    const payload = json as {
      event?: string
      id?: string
      data?: {
        bot?: { id?: string }
        data?: {
          code?: string
          sub_code?: string | null
          updated_at?: string
          words?: Array<{ text: string; start_timestamp?: { absolute?: string }; end_timestamp?: { absolute?: string } }>
          participant?: { id?: string | number; name?: string }
        }
      }
    }

    const eventName = payload.event
    const botId = payload.data?.bot?.id
    if (!eventName || !botId) return []

    const providerEventId = payload.id ?? `${eventName}:${botId}:${payload.data?.data?.updated_at ?? Date.now()}`
    const occurredAt = payload.data?.data?.updated_at ?? new Date().toISOString()
    const base = { providerBotId: botId, providerEventId, occurredAt, raw: payload as Record<string, unknown> }

    if (eventName.startsWith('bot.')) {
      const code = payload.data?.data?.code ?? eventName.slice('bot.'.length)
      const type = mapStatusCodeToEventType(code)
      if (!type) return []
      if (type === 'bot_error') {
        return [{ ...base, type, errorMessage: payload.data?.data?.sub_code ?? 'Bot reported a fatal error.' }]
      }
      return [{ ...base, type }]
    }

    if (eventName === 'transcript.data' || eventName === 'transcript.partial_data') {
      const words = payload.data?.data?.words ?? []
      const text = words.map((w) => w.text).join(' ')
      if (!text) return []
      const participant = payload.data?.data?.participant
      return [{
        ...base,
        type: 'transcript_segment',
        transcriptSegment: {
          providerParticipantId: participant?.id != null ? String(participant.id) : null,
          speakerName: participant?.name ?? null,
          text,
          startedAt: words[0]?.start_timestamp?.absolute ?? null,
          endedAt: words[words.length - 1]?.end_timestamp?.absolute ?? null,
          confidence: null,
        },
      }]
    }

    if (eventName === 'participant_events.join' || eventName === 'participant_events.leave') {
      const p = payload.data?.data?.participant
      if (p?.id == null) return []
      return [{
        ...base,
        type: eventName === 'participant_events.join' ? 'participant_joined' : 'participant_left',
        participant: { providerParticipantId: String(p.id), displayName: p.name ?? null },
      }]
    }

    return []
  }
}

function mapStatusCodeToEventType(code: string): MeetingProviderEventType | null {
  switch (code) {
    case 'joining_call': return 'bot_joining'
    case 'in_waiting_room': return 'bot_waiting_room'
    case 'in_call_not_recording':
    case 'recording_permission_allowed':
    case 'in_call_recording': return 'bot_admitted'
    case 'call_ended': return 'meeting_ended'
    case 'done': return 'bot_removed'
    case 'fatal': return 'bot_error'
    default: return null
  }
}
