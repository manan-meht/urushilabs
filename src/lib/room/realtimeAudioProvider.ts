'use client'

/**
 * Browser WebRTC client for OpenAI's Realtime API. Connects directly to OpenAI
 * using a short-lived ephemeral client secret minted server-side (the permanent
 * API key never reaches the browser) — see /api/room/sessions/[id]/realtime-token.
 *
 * turn_detection.create_response is false (configured server-side in
 * src/lib/ai/realtime/config.ts): the model never auto-replies. Urushi only speaks
 * when triggerAssistantResponse() is called, driven by the mediation controller.
 *
 * NOTE: this implementation follows OpenAI's documented WebRTC ephemeral-token flow
 * as of writing (POST SDP offer to https://api.openai.com/v1/realtime/calls, data
 * channel named "oai-events"). Re-verify event names against current docs if OpenAI
 * changes the Realtime API — this hasn't been exercised against a live account in
 * this environment (no real API key / mic hardware available here).
 */

import type { AudioProvider, AudioProviderCallbacks } from './audioProvider'
import { classifyMicError, MIC_ERROR_MESSAGES } from './micError'

const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls'

export class RealtimeAudioProvider implements AudioProvider {
  private pc: RTCPeerConnection | null = null
  private dataChannel: RTCDataChannel | null = null
  private localStream: MediaStream | null = null
  private remoteAudioEl: HTMLAudioElement | null = null
  private muted = false
  private assistantSpeaking = false

  constructor(
    private readonly clientSecret: string,
    private readonly callbacks: AudioProviderCallbacks
  ) {}

  async connect(): Promise<void> {
    this.callbacks.onStatusChange('connecting')

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (err) {
      this.callbacks.onStatusChange('error')
      const kind = classifyMicError(err)
      this.callbacks.onError(new Error(MIC_ERROR_MESSAGES[kind]))
      throw err
    }

    const pc = new RTCPeerConnection()
    this.pc = pc

    for (const track of this.localStream.getAudioTracks()) {
      pc.addTrack(track, this.localStream)
    }

    this.remoteAudioEl = new Audio()
    this.remoteAudioEl.autoplay = true
    pc.ontrack = (event) => {
      if (this.remoteAudioEl) this.remoteAudioEl.srcObject = event.streams[0] ?? null
    }

    pc.onconnectionstatechange = () => {
      if (!this.pc) return
      if (this.pc.connectionState === 'connected') {
        this.callbacks.onStatusChange('connected')
      } else if (this.pc.connectionState === 'disconnected') {
        this.callbacks.onStatusChange('reconnecting')
      } else if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') {
        this.callbacks.onStatusChange('disconnected')
      }
    }

    const dc = pc.createDataChannel('oai-events')
    this.dataChannel = dc
    dc.onmessage = (event) => this.handleServerEvent(event.data)
    dc.onerror = () => this.callbacks.onError(new Error('Realtime data channel error.'))

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    const res = await fetch(REALTIME_CALLS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.clientSecret}`,
        'Content-Type': 'application/sdp',
      },
      body: offer.sdp,
    })

    if (!res.ok) {
      const text = await res.text()
      this.callbacks.onStatusChange('error')
      const error = new Error(`Realtime connection failed (${res.status}): ${text}`)
      this.callbacks.onError(error)
      throw error
    }

    const answerSdp = await res.text()
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
  }

  disconnect(): void {
    this.dataChannel?.close()
    this.dataChannel = null

    this.pc?.getSenders().forEach((sender) => sender.track?.stop())
    this.pc?.close()
    this.pc = null

    this.localStream?.getTracks().forEach((track) => track.stop())
    this.localStream = null

    if (this.remoteAudioEl) {
      this.remoteAudioEl.srcObject = null
      this.remoteAudioEl = null
    }

    this.callbacks.onStatusChange('disconnected')
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted
    })
  }

  isMuted(): boolean {
    return this.muted
  }

  triggerAssistantResponse(instructions: string): void {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') return
    this.dataChannel.send(JSON.stringify({
      type: 'response.create',
      response: { instructions },
    }))
  }

  private cancelAssistantResponse(): void {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') return
    if (!this.assistantSpeaking) return
    this.dataChannel.send(JSON.stringify({ type: 'response.cancel' }))
  }

  private handleServerEvent(raw: string): void {
    let event: { type?: string; transcript?: string; item_id?: string } & Record<string, unknown>
    try {
      event = JSON.parse(raw)
    } catch {
      return
    }

    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        // A participant started talking — barge-in: stop Urushi immediately if speaking.
        this.cancelAssistantResponse()
        break

      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = typeof event['transcript'] === 'string' ? event['transcript'] as string : ''
        const speakerLabel = typeof event['speaker'] === 'string' ? event['speaker'] as string : undefined
        if (transcript.trim()) {
          this.callbacks.onTranscript({ content: transcript, final: true, diarizationSpeakerLabel: speakerLabel })
        }
        break
      }

      case 'response.created':
        this.assistantSpeaking = true
        this.callbacks.onAssistantSpeakingChange(true)
        break

      case 'response.done':
      case 'response.cancelled':
        this.assistantSpeaking = false
        this.callbacks.onAssistantSpeakingChange(false)
        break

      case 'error':
        this.callbacks.onError(new Error(typeof event['message'] === 'string' ? event['message'] as string : 'Realtime API error.'))
        break

      default:
        break
    }
  }
}
