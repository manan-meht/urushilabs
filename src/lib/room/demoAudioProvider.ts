'use client'

/**
 * Demo/local fallback audio provider — used when the server has no real
 * OPENAI_API_KEY configured (DEMO_MODE) so the rest of the Room Mode experience
 * (mic permission, wake lock, live UI, the intervene API loop, controller
 * guardrails) can still be exercised end-to-end without a real Realtime API
 * connection or cost. Uses the browser's built-in SpeechRecognition where
 * available so transcripts are real speech, not fabricated text.
 *
 * This is NOT part of the production Realtime/WebRTC architecture — see
 * realtimeAudioProvider.ts for that. "Urushi speaking" is simulated via the
 * browser's speechSynthesis API so the UI's speaking-state still behaves
 * correctly in demo mode.
 */

import type { AudioProvider, AudioProviderCallbacks } from './audioProvider'
import { classifyMicError, MIC_ERROR_MESSAGES } from './micError'

interface SpeechRecognitionResultLike {
  isFinal: boolean
  0: { transcript: string }
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<SpeechRecognitionResultLike>
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export class DemoAudioProvider implements AudioProvider {
  private recognition: SpeechRecognitionLike | null = null
  private stream: MediaStream | null = null
  private muted = false
  private stopped = false

  constructor(private readonly callbacks: AudioProviderCallbacks) {}

  async connect(): Promise<void> {
    this.callbacks.onStatusChange('connecting')

    try {
      // Request mic permission even though this demo path doesn't stream audio
      // anywhere, so the permission-request UX matches the production path exactly.
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      this.callbacks.onStatusChange('error')
      const kind = classifyMicError(err)
      this.callbacks.onError(new Error(MIC_ERROR_MESSAGES[kind]))
      throw err
    }

    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) {
      // No speech recognition available — still "connected" so pause/mute/end work,
      // just without live transcription in this demo fallback.
      this.callbacks.onStatusChange('connected')
      return
    }

    const recognition = new Ctor()
    recognition.continuous = true
    recognition.interimResults = false
    recognition.lang = 'en-US'

    recognition.onresult = (event) => {
      if (this.muted) return
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result?.isFinal) {
          const text = result[0]?.transcript?.trim()
          if (text) this.callbacks.onTranscript({ content: text, final: true })
        }
      }
    }
    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return
      this.callbacks.onError(new Error(`Speech recognition error: ${event.error}`))
    }
    recognition.onend = () => {
      // Browsers auto-stop recognition after a period of silence — restart while active.
      if (!this.stopped) {
        try {
          recognition.start()
        } catch {
          // Already starting — ignore.
        }
      }
    }

    this.recognition = recognition
    try {
      recognition.start()
    } catch (err) {
      console.warn('[DemoAudioProvider] Failed to start speech recognition:', err)
    }

    this.callbacks.onStatusChange('connected')
  }

  disconnect(): void {
    this.stopped = true
    this.recognition?.stop()
    this.recognition = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    this.callbacks.onStatusChange('disconnected')
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted
    })
  }

  isMuted(): boolean {
    return this.muted
  }

  triggerAssistantResponse(instructions: string): void {
    this.callbacks.onAssistantSpeakingChange(true)
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      this.callbacks.onAssistantSpeakingChange(false)
      return
    }
    const utterance = new SpeechSynthesisUtterance(instructions)
    utterance.onend = () => this.callbacks.onAssistantSpeakingChange(false)
    utterance.onerror = () => this.callbacks.onAssistantSpeakingChange(false)
    window.speechSynthesis.speak(utterance)
  }
}
