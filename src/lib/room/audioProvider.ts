/**
 * Shared contract between the real OpenAI Realtime WebRTC provider and the
 * demo/local fallback provider, so RoomSessionClient (the transport-agnostic
 * engine) never needs to know which one it's talking to. Per the architecture in
 * spec §28, the browser is one client of Room Mode — this interface is the seam
 * a future non-browser client (e.g. a hardware device) would also implement.
 */

export type AudioProviderStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error'

export interface TranscriptEvent {
  content: string
  /** True once the utterance is final and safe to send to the mediation controller. */
  final: boolean
  diarizationSpeakerLabel?: string
  confidence?: number
}

export interface AudioProviderCallbacks {
  onStatusChange: (status: AudioProviderStatus) => void
  onTranscript: (event: TranscriptEvent) => void
  onAssistantSpeakingChange: (speaking: boolean) => void
  onError: (error: Error) => void
}

export interface AudioProvider {
  connect(): Promise<void>
  disconnect(): void
  setMuted(muted: boolean): void
  isMuted(): boolean
  /** Manually trigger Urushi to speak — the mediation controller calls this, never automatic turn-taking. */
  triggerAssistantResponse(instructions: string): void
}
