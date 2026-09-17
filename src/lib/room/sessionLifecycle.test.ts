import { describe, it, expect } from 'vitest'
import { getReconnectDelay, canEndSession, canStartMediation, RECONNECT_DELAYS_MS } from './sessionLifecycle'

describe('getReconnectDelay', () => {
  it('returns increasing delays for each attempt', () => {
    expect(getReconnectDelay(0)).toBe(RECONNECT_DELAYS_MS[0])
    expect(getReconnectDelay(1)).toBe(RECONNECT_DELAYS_MS[1])
    expect(getReconnectDelay(2)).toBe(RECONNECT_DELAYS_MS[2])
  })

  it('returns null once attempts are exhausted', () => {
    expect(getReconnectDelay(RECONNECT_DELAYS_MS.length)).toBeNull()
    expect(getReconnectDelay(99)).toBeNull()
  })
})

describe('canEndSession', () => {
  it('allows ending while live or paused', () => {
    expect(canEndSession('live')).toBe(true)
    expect(canEndSession('paused')).toBe(true)
  })

  it('does not allow ending before the session has started', () => {
    expect(canEndSession('setup')).toBe(false)
    expect(canEndSession('consent')).toBe(false)
    expect(canEndSession('ready')).toBe(false)
  })

  it('does not allow ending an already-completed session', () => {
    expect(canEndSession('completed')).toBe(false)
  })
})

describe('canStartMediation', () => {
  it('allows starting from ready, live, or paused', () => {
    expect(canStartMediation('ready')).toBe(true)
    expect(canStartMediation('live')).toBe(true)
    expect(canStartMediation('paused')).toBe(true)
  })

  it('blocks starting before consent or after completion', () => {
    expect(canStartMediation('setup')).toBe(false)
    expect(canStartMediation('consent')).toBe(false)
    expect(canStartMediation('completed')).toBe(false)
  })
})
