'use client'

/**
 * RoomSession — the transport-agnostic Live Mediation engine described in spec §28:
 *
 *   LiveMediationClient → RoomSession → MediationController → RealtimeAudioProvider → mediation state
 *
 * This class owns local mediation state and orchestrates an AudioProvider (real
 * WebRTC or the demo fallback) plus calls to our backend's mediation controller. It
 * has no React/DOM dependency beyond the AudioProvider it's given, and no
 * browser-specific logic of its own — a future non-browser client (e.g. a hardware
 * device) would implement its own AudioProvider and reuse this class as-is.
 */

import type { AudioProvider, AudioProviderStatus } from './audioProvider'
import { RealtimeAudioProvider } from './realtimeAudioProvider'
import { DemoAudioProvider } from './demoAudioProvider'
import { WakeLockController } from './wakeLock'
import { getReconnectDelay } from './sessionLifecycle'

export interface RoomTranscriptLine {
  id: string
  speaker: 'urushi' | 'participant'
  content: string
  timestamp: number
}

export interface RoomSessionState {
  status: AudioProviderStatus
  assistantSpeaking: boolean
  thinking: boolean
  muted: boolean
  paused: boolean
  currentIssueTitle: string | null
  emergingAgreement: string | null
  transcript: RoomTranscriptLine[]
  error: string | null
  /** Raw diarization label of the most recent participant utterance — used during speaker calibration. */
  lastDiarizationLabel: string | null
  calibrating: boolean
}

export type RoomSessionListener = (state: RoomSessionState) => void

interface TokenResponse {
  demo?: boolean
  clientSecret?: string
  model?: string
  voice?: string
  error?: string
}

interface InterveneResponse {
  decision: {
    action: string
    reasoning: string
    spokenText?: string
    currentIssueTitle?: string
    emergingAgreement?: string
  }
  issueId: string | null
  agreementId: string | null
}

export class RoomSessionClient {
  private state: RoomSessionState = {
    status: 'idle',
    assistantSpeaking: false,
    thinking: false,
    muted: false,
    paused: false,
    currentIssueTitle: null,
    emergingAgreement: null,
    transcript: [],
    error: null,
    lastDiarizationLabel: null,
    calibrating: true,
  }

  private listeners = new Set<RoomSessionListener>()
  private audioProvider: AudioProvider | null = null
  private wakeLock = new WakeLockController()
  private reconnectAttempt = 0

  constructor(private readonly sessionId: string) {}

  subscribe(listener: RoomSessionListener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  private setState(patch: Partial<RoomSessionState>): void {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((l) => l(this.state))
  }

  private pushTranscript(speaker: 'urushi' | 'participant', content: string): void {
    const line: RoomTranscriptLine = { id: crypto.randomUUID(), speaker, content, timestamp: Date.now() }
    this.setState({ transcript: [...this.state.transcript.slice(-49), line] })
  }

  async start(): Promise<void> {
    this.setState({ error: null })
    await this.wakeLock.acquire()

    let token: TokenResponse
    try {
      const res = await fetch(`/api/room/sessions/${this.sessionId}/realtime-token`, { method: 'POST' })
      token = await res.json() as TokenResponse
      if (!res.ok) throw new Error(token.error ?? 'Failed to start Live Mediation.')
    } catch (err) {
      this.setState({ status: 'error', error: err instanceof Error ? err.message : 'Connection failed.' })
      throw err
    }

    const callbacks = {
      onStatusChange: (status: AudioProviderStatus) => {
        this.setState({ status })
        if (status === 'disconnected' || status === 'error') {
          void this.attemptReconnect()
        }
      },
      onTranscript: (event: { content: string; final: boolean; diarizationSpeakerLabel?: string; confidence?: number }) => {
        if (!event.final) return
        this.setState({ lastDiarizationLabel: event.diarizationSpeakerLabel ?? null })
        this.pushTranscript('participant', event.content)
        // While calibrating, the UI drives speaker mapping directly (see calibrateParticipant) —
        // don't run the mediation controller over calibration small-talk.
        if (this.state.calibrating) return
        void this.reportUtterance(event.content, event.diarizationSpeakerLabel, event.confidence)
      },
      onAssistantSpeakingChange: (speaking: boolean) => this.setState({ assistantSpeaking: speaking }),
      onError: (error: Error) => this.setState({ error: error.message }),
    }

    this.audioProvider = token.demo
      ? new DemoAudioProvider(callbacks)
      : new RealtimeAudioProvider(token.clientSecret!, callbacks)

    await this.audioProvider.connect()
    this.reconnectAttempt = 0
  }

  private async attemptReconnect(): Promise<void> {
    if (this.state.paused) return
    const delay = getReconnectDelay(this.reconnectAttempt)
    if (delay === null) {
      this.setState({ error: 'Connection lost. You can continue by typing, or end the session.' })
      return
    }
    this.reconnectAttempt += 1
    this.setState({ status: 'reconnecting' })
    await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      await this.start()
    } catch {
      // start() already updates state on failure; attemptReconnect will be retried
      // via the next onStatusChange('error'/'disconnected') callback.
    }
  }

  private async reportUtterance(content: string, diarizationSpeakerLabel?: string, confidence?: number): Promise<void> {
    this.setState({ thinking: true })
    try {
      const res = await fetch(`/api/room/sessions/${this.sessionId}/intervene`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, diarizationSpeakerLabel, speakerConfidence: confidence }),
      })
      if (!res.ok) return
      const data = await res.json() as InterveneResponse

      if (data.decision.currentIssueTitle) this.setState({ currentIssueTitle: data.decision.currentIssueTitle })
      if (data.decision.emergingAgreement) this.setState({ emergingAgreement: data.decision.emergingAgreement })

      if (data.decision.action !== 'LISTEN' && data.decision.spokenText) {
        this.pushTranscript('urushi', data.decision.spokenText)
        this.audioProvider?.triggerAssistantResponse(
          `Say this to the room, naturally, in your own voice: "${data.decision.spokenText}"`
        )
      }
    } catch (err) {
      console.warn('[RoomSessionClient] Failed to report utterance:', err)
    } finally {
      this.setState({ thinking: false })
    }
  }

  /**
   * Maps the most recent utterance's diarization label to a participant, during the
   * brief calibration step at the start of the meeting. Probabilistic — stored with
   * whatever confidence the transcription provided, never treated as certain.
   */
  async calibrateParticipant(participantId: string): Promise<void> {
    const label = this.state.lastDiarizationLabel
    if (!label) return
    try {
      await fetch(`/api/room/sessions/${this.sessionId}/participants/${participantId}/calibrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diarizationLabel: label }),
      })
    } catch {
      // Best-effort — mediation still works without a confirmed mapping, Urushi will
      // just ask "was that X speaking?" more often.
    }
  }

  finishCalibration(): void {
    this.setState({ calibrating: false })
  }

  /** Fallback path when voice isn't available — same loop, typed input. */
  async submitTypedUtterance(content: string): Promise<void> {
    this.pushTranscript('participant', content)
    await this.reportUtterance(content)
  }

  setMuted(muted: boolean): void {
    this.audioProvider?.setMuted(muted)
    this.setState({ muted })
  }

  async pause(): Promise<void> {
    this.setState({ paused: true })
    this.audioProvider?.setMuted(true)
    try {
      await fetch(`/api/room/sessions/${this.sessionId}/pause`, { method: 'POST' })
    } catch {
      // Best-effort — local paused state still holds.
    }
  }

  async resume(): Promise<void> {
    this.setState({ paused: false })
    this.audioProvider?.setMuted(this.state.muted)
    try {
      await fetch(`/api/room/sessions/${this.sessionId}/resume`, { method: 'POST' })
    } catch {
      // Best-effort.
    }
  }

  async end(): Promise<{ report: unknown } | null> {
    this.audioProvider?.disconnect()
    this.audioProvider = null
    await this.wakeLock.release()

    try {
      const res = await fetch(`/api/room/sessions/${this.sessionId}/complete`, { method: 'POST' })
      if (!res.ok) return null
      return await res.json() as { report: unknown }
    } catch {
      return null
    }
  }

  async dispose(): Promise<void> {
    this.audioProvider?.disconnect()
    this.audioProvider = null
    await this.wakeLock.release()
    this.listeners.clear()
  }
}
