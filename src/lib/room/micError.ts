/**
 * Classifies getUserMedia failures into user-facing categories. Pure — no DOM
 * access — so it's unit-testable without a browser. Mirrors the classification
 * already done for voice-note recording in
 * src/app/case/[reference]/intake/useVoiceRecorder.ts.
 */

export type MicErrorKind = 'permission-denied' | 'no-device' | 'in-use' | 'insecure-context' | 'unsupported' | 'unknown'

export function classifyMicError(err: unknown): MicErrorKind {
  const name = err instanceof Error ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'permission-denied'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'no-device'
    case 'NotReadableError':
    case 'TrackStartError':
      return 'in-use'
    default:
      return 'unknown'
  }
}

export const MIC_ERROR_MESSAGES: Record<MicErrorKind, string> = {
  'permission-denied': "Microphone access was denied. You'll need to allow it to use Live Mediation.",
  'no-device': 'No microphone was found on this device.',
  'in-use': 'The microphone is being used by another app.',
  'insecure-context': 'Live Mediation requires a secure (https) connection.',
  unsupported: "This browser doesn't support microphone access.",
  unknown: 'Could not access the microphone. Please try again.',
}
