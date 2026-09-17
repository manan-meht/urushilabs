import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hashToken } from '@/lib/tokens'

const mockGetUser = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: () => mockGetUser() } }),
}))

function makeQueryBuilder(getResult: () => { data: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {}
  const chain = ['insert', 'select', 'eq', 'is', 'order', 'limit', 'update']
  for (const method of chain) {
    builder[method] = vi.fn(() => builder)
  }
  builder['single'] = vi.fn(async () => getResult())
  builder['maybeSingle'] = vi.fn(async () => getResult())
  ;(builder as { then: PromiseLike<unknown>['then'] }).then = (resolve, reject) =>
    Promise.resolve(getResult()).then(resolve, reject)
  return builder
}

let deviceResult: { data: unknown; error?: unknown }
let sessionResult: { data: unknown; error?: unknown }

vi.mock('@/lib/db/client', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      if (table === 'room_devices') return makeQueryBuilder(() => deviceResult)
      if (table === 'room_sessions') return makeQueryBuilder(() => sessionResult)
      return makeQueryBuilder(() => ({ data: null }))
    },
  }),
}))

import { requireRoomSessionByDeviceToken, requireRoomSessionAccess, isAccessError } from './getSession'

const DEVICE_TOKEN = 'a-real-device-token'
const SESSION_ID = 'session-1'

const VALID_SESSION_ROW = {
  id: SESSION_ID,
  case_id: 'case-1',
  stage: 'live',
  cases: { id: 'case-1', user_id: 'owner-1' },
}

function makeRequest(headers: Record<string, string> = {}) {
  return { headers: new Headers(headers) } as unknown as import('next/server').NextRequest
}

beforeEach(() => {
  vi.clearAllMocks()
  deviceResult = { data: { id: 'device-1', session_id: SESSION_ID, revoked_at: null, cases: { id: 'case-1', user_id: 'owner-1' } } }
  sessionResult = { data: VALID_SESSION_ROW }
  mockGetUser.mockResolvedValue({ data: { user: null } })
})

describe('requireRoomSessionByDeviceToken', () => {
  it('resolves access for a valid, unrevoked device token on the matching session', async () => {
    const result = await requireRoomSessionByDeviceToken(DEVICE_TOKEN, SESSION_ID)
    expect(isAccessError(result)).toBe(false)
    if (!isAccessError(result)) {
      expect(result.caseId).toBe('case-1')
      expect(result.userId).toBe('owner-1')
      expect(result.session.id).toBe(SESSION_ID)
    }
  })

  it('rejects an empty token', async () => {
    const result = await requireRoomSessionByDeviceToken('', SESSION_ID)
    expect(isAccessError(result)).toBe(true)
    if (isAccessError(result)) expect(result.status).toBe(401)
  })

  it('rejects an unknown token (no matching device row)', async () => {
    deviceResult = { data: null }
    const result = await requireRoomSessionByDeviceToken('not-a-real-token', SESSION_ID)
    expect(isAccessError(result)).toBe(true)
    if (isAccessError(result)) expect(result.status).toBe(401)
  })

  it('rejects a token that is valid for a different session', async () => {
    deviceResult = { data: { id: 'device-1', session_id: 'some-other-session', revoked_at: null, cases: { id: 'case-1', user_id: 'owner-1' } } }
    const result = await requireRoomSessionByDeviceToken(DEVICE_TOKEN, SESSION_ID)
    expect(isAccessError(result)).toBe(true)
    if (isAccessError(result)) expect(result.status).toBe(401)
  })

  it('rejects when the device row is missing (e.g. revoked — filtered out by the query itself)', async () => {
    // requireRoomSessionByDeviceToken's query filters .is('revoked_at', null), so a
    // revoked device resolves as "no row found" exactly like an unknown token.
    deviceResult = { data: null }
    const result = await requireRoomSessionByDeviceToken(DEVICE_TOKEN, SESSION_ID)
    expect(isAccessError(result)).toBe(true)
  })

  it('returns 404 when the device is valid but the session no longer exists', async () => {
    sessionResult = { data: null }
    const result = await requireRoomSessionByDeviceToken(DEVICE_TOKEN, SESSION_ID)
    expect(isAccessError(result)).toBe(true)
    if (isAccessError(result)) expect(result.status).toBe(404)
  })

  it('never needs the plaintext token to match anything but its hash', () => {
    // Sanity check on the primitive itself — same token always hashes the same way,
    // and hashing is what the DB lookup keys off, never the plaintext.
    expect(hashToken(DEVICE_TOKEN)).toBe(hashToken(DEVICE_TOKEN))
    expect(hashToken(DEVICE_TOKEN)).not.toBe(DEVICE_TOKEN)
  })
})

describe('requireRoomSessionAccess', () => {
  it('uses the device token path when a Bearer Authorization header is present', async () => {
    const result = await requireRoomSessionAccess(makeRequest({ authorization: `Bearer ${DEVICE_TOKEN}` }), SESSION_ID)
    expect(isAccessError(result)).toBe(false)
    // Cookie auth was never consulted for this request.
    expect(mockGetUser).not.toHaveBeenCalled()
  })

  it('falls back to cookie auth when no Authorization header is present', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'owner-1' } } })
    const result = await requireRoomSessionAccess(makeRequest(), SESSION_ID)
    expect(isAccessError(result)).toBe(false)
    expect(mockGetUser).toHaveBeenCalledOnce()
  })

  it('falls back to cookie auth when the Authorization header is not a Bearer token', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'owner-1' } } })
    const result = await requireRoomSessionAccess(makeRequest({ authorization: 'Basic dXNlcjpwYXNz' }), SESSION_ID)
    expect(isAccessError(result)).toBe(false)
    expect(mockGetUser).toHaveBeenCalledOnce()
  })

  it('rejects when neither a valid device token nor a signed-in owner is present', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const result = await requireRoomSessionAccess(makeRequest(), SESSION_ID)
    expect(isAccessError(result)).toBe(true)
    if (isAccessError(result)) expect(result.status).toBe(401)
  })
})
