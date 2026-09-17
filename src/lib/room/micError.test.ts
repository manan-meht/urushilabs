import { describe, it, expect } from 'vitest'
import { classifyMicError, MIC_ERROR_MESSAGES } from './micError'

function domError(name: string): Error {
  const err = new Error(name)
  err.name = name
  return err
}

describe('classifyMicError', () => {
  it('classifies permission-denied errors', () => {
    expect(classifyMicError(domError('NotAllowedError'))).toBe('permission-denied')
    expect(classifyMicError(domError('PermissionDeniedError'))).toBe('permission-denied')
  })

  it('classifies missing-device errors', () => {
    expect(classifyMicError(domError('NotFoundError'))).toBe('no-device')
  })

  it('classifies device-in-use errors', () => {
    expect(classifyMicError(domError('NotReadableError'))).toBe('in-use')
  })

  it('falls back to unknown for unrecognised errors', () => {
    expect(classifyMicError(domError('SomethingWeird'))).toBe('unknown')
    expect(classifyMicError('not an error object')).toBe('unknown')
  })

  it('has a human-readable message for every classification', () => {
    for (const kind of Object.keys(MIC_ERROR_MESSAGES) as Array<keyof typeof MIC_ERROR_MESSAGES>) {
      expect(MIC_ERROR_MESSAGES[kind].length).toBeGreaterThan(0)
    }
  })
})
