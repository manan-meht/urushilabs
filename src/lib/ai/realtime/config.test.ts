import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetEnv = vi.fn()
vi.mock('@/lib/env', () => ({ getEnv: () => mockGetEnv() }))

import { buildRealtimeSessionConfig, buildTranscriptionPrompt } from './config'

beforeEach(() => {
  mockGetEnv.mockReturnValue({
    OPENAI_REALTIME_MODEL: 'gpt-realtime',
    OPENAI_REALTIME_TRANSCRIBE_MODEL: 'gpt-4o-transcribe',
    OPENAI_REALTIME_VOICE: 'cedar',
    OPENAI_REALTIME_TRANSCRIBE_LANGUAGES: 'en,hi',
  })
})

describe('buildTranscriptionPrompt', () => {
  it('names both languages and warns about code-switching', () => {
    const prompt = buildTranscriptionPrompt(['en', 'hi'])
    expect(prompt).toContain('English or Hindi')
    expect(prompt).toContain('Hinglish')
  })

  it('omits the code-switch note for a single language', () => {
    const prompt = buildTranscriptionPrompt(['en'])
    expect(prompt).toContain('English')
    expect(prompt).not.toContain('Hinglish')
  })

  it('falls back to the raw code for a language it has no name for', () => {
    expect(buildTranscriptionPrompt(['ta'])).toContain('ta')
  })

  it('always teaches the transcriber the mediator\'s name', () => {
    // Without this, "Urushi" gets mangled into whatever common word sounds
    // closest on far-field audio ("जी", "तो"), the name never reaches
    // detectDirectAddress, and asking the mediator to speak silently fails.
    for (const languages of [[], ['en'], ['en', 'hi']]) {
      expect(buildTranscriptionPrompt(languages), JSON.stringify(languages)).toContain('Urushi')
    }
  })

  it('still steers away from hallucination with no languages configured', () => {
    // Unsteered far-field audio came back as Icelandic and Japanese in real
    // testing — the base prompt is what keeps that in check.
    const prompt = buildTranscriptionPrompt([])
    expect(prompt).toContain('Do not invent content')
  })
})

describe('buildRealtimeSessionConfig', () => {
  it('nests everything under session.type=realtime', () => {
    // Regression: sending `model` at the top level is rejected by
    // POST /v1/realtime/client_secrets with "Unknown parameter: 'model'".
    const config = buildRealtimeSessionConfig({ instructions: 'be helpful' })
    expect(config).not.toHaveProperty('model')
    expect(config.session.type).toBe('realtime')
    expect(config.session.model).toBe('gpt-realtime')
    expect(config.session.instructions).toBe('be helpful')
  })

  it('never lets the Realtime API reply on its own', () => {
    // The mediation controller owns every decision to speak. If this flips,
    // Urushi answers everything and listen-by-default is gone.
    const { turn_detection } = buildRealtimeSessionConfig({ instructions: '' }).session.audio.input
    expect(turn_detection.create_response).toBe(false)
    expect(turn_detection.interrupt_response).toBe(true)
  })

  it('closes turns often enough that a dropped connection cannot swallow a whole account', () => {
    // Not 'low'. Transcripts emit only when a turn closes, and a WebRTC drop
    // destroys an open turn — so the longer a turn stays open, the more speech a
    // drop can erase. Observed live: two paragraphs reached the mediator as
    // nothing at all.
    const { turn_detection } = buildRealtimeSessionConfig({ instructions: '' }).session.audio.input
    expect(turn_detection.type).toBe('semantic_vad')
    expect(turn_detection.eagerness).not.toBe('low')
  })

  it('steers transcription language via prompt, never a languages field', () => {
    // Regression: gpt-4o-transcribe rejects `languages` ("not supported for this
    // model"), and singular `language` would pin one and break bilingual rooms.
    const { transcription } = buildRealtimeSessionConfig({ instructions: '' }).session.audio.input
    expect(transcription).not.toHaveProperty('languages')
    expect(transcription).not.toHaveProperty('language')
    expect(transcription.prompt).toContain('English or Hindi')
  })

  it('uses far-field noise reduction for a phone in the middle of a table', () => {
    const { noise_reduction } = buildRealtimeSessionConfig({ instructions: '' }).session.audio.input
    expect(noise_reduction.type).toBe('far_field')
  })
})
