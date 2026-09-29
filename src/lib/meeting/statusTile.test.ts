import { describe, it, expect } from 'vitest'
import { signStatusTile, verifyStatusTile } from './statusTile'

const SECRET = 'test-secret-with-enough-entropy'

describe('status tile URL signing', () => {
  it('round-trips', () => {
    const sig = signStatusTile('sess-1', SECRET)
    expect(verifyStatusTile('sess-1', sig, SECRET)).toBe(true)
  })

  it('does not let one meeting derive another meeting\'s tile', () => {
    // The URL is the only credential the bot's browser has, so it must not be
    // guessable from a neighbouring session.
    const sig = signStatusTile('sess-1', SECRET)
    expect(verifyStatusTile('sess-2', sig, SECRET)).toBe(false)
  })

  it('rejects a tampered or truncated signature', () => {
    const sig = signStatusTile('sess-1', SECRET)
    expect(verifyStatusTile('sess-1', sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a'), SECRET)).toBe(false)
    expect(verifyStatusTile('sess-1', sig.slice(0, 10), SECRET)).toBe(false)
    expect(verifyStatusTile('sess-1', '', SECRET)).toBe(false)
  })

  it('refuses to sign without a secret rather than producing a predictable value', () => {
    // An unconfigured deployment should fail here, not hand out enumerable tiles.
    expect(() => signStatusTile('sess-1', '')).toThrow(/SESSION_SECRET/)
    expect(verifyStatusTile('sess-1', 'x'.repeat(32), '')).toBe(false)
  })
})
