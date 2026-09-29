/**
 * The bot's camera tile: a status screen the room can see.
 *
 * In two live sessions every intervention began while a human was already
 * talking. Part of that is latency nothing here can remove — Recall hands us a
 * transcript ~13s after the words, and our decision adds 7-16s. What the room
 * needed was a signal in that window, and a chat message is a signal in a side
 * panel nobody is watching. Recall's output_media streams a live webpage into
 * the bot's camera, in the participant grid where everyone is already looking;
 * its own docs list "status screens" as the use case.
 *
 * The page is public — the bot's browser loads it with no session of ours — so
 * its URL is the credential. It is signed, not guessed at: an HMAC over the
 * session id under SESSION_SECRET, so the tile for one meeting cannot be derived
 * from another's, and a URL that leaks shows only three words of status.
 */

import crypto from 'node:crypto'
import { getEnv } from '@/lib/env'

export type BotStatus = 'listening' | 'thinking' | 'speaking'

const SIG_LENGTH = 32

function hmac(sessionId: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`status-tile:${sessionId}`).digest('hex').slice(0, SIG_LENGTH)
}

/**
 * Refuses rather than signs when the secret is unset. A predictable signature
 * is worse than no tile, and an unconfigured deployment should find out here
 * rather than by someone enumerating tiles.
 */
export function signStatusTile(sessionId: string, secret = getEnv().SESSION_SECRET): string {
  if (!secret) throw new Error('SESSION_SECRET is not configured; cannot sign a status tile URL.')
  return hmac(sessionId, secret)
}

export function verifyStatusTile(sessionId: string, sig: string, secret = getEnv().SESSION_SECRET): boolean {
  if (!secret || !sig || sig.length !== SIG_LENGTH) return false
  const expected = Buffer.from(hmac(sessionId, secret), 'utf8')
  const given = Buffer.from(sig, 'utf8')
  return expected.length === given.length && crypto.timingSafeEqual(expected, given)
}

/** Absolute URL the bot's camera will load. */
export function statusTileUrl(sessionId: string): string {
  const { NEXT_PUBLIC_APP_URL } = getEnv()
  return `${NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/meeting/tile/${sessionId}/${signStatusTile(sessionId)}`
}
