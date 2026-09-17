import { describe, it, expect, vi, beforeEach } from 'vitest'

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

let sessionResult: { data: unknown; error?: unknown }
let insertResult: { data: unknown; error?: unknown }
let listResult: { data: unknown; error?: unknown }
const insertedRows: unknown[] = []

vi.mock('@/lib/db/client', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      if (table === 'room_sessions') return makeQueryBuilder(() => sessionResult)
      if (table === 'room_devices') {
        const builder = makeQueryBuilder(() => insertResult)
        builder['insert'] = vi.fn((row: unknown) => {
          insertedRows.push(row)
          return builder
        })
        // order() is only used by the GET (list) path, which reads listResult instead.
        builder['order'] = vi.fn(async () => listResult)
        return builder
      }
      return makeQueryBuilder(() => ({ data: null }))
    },
  }),
}))

vi.mock('@/lib/tokens', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tokens')>('@/lib/tokens')
  return { ...actual, generateSecureToken: () => 'fixed-test-token' }
})

import { POST, GET } from './route'

const SESSION_ROW = { id: 'session-1', case_id: 'case-1', stage: 'live', cases: { id: 'case-1', user_id: 'owner-1' } }

function makeRequest(body?: unknown) {
  return {
    json: async () => {
      if (body === undefined) throw new Error('no body')
      return body
    },
  } as unknown as import('next/server').NextRequest
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  insertedRows.length = 0
  sessionResult = { data: SESSION_ROW }
  insertResult = { data: { id: 'device-1', label: null, paired_at: '2026-01-01T00:00:00Z' } }
  listResult = { data: [] }
  mockGetUser.mockResolvedValue({ data: { user: { id: 'owner-1' } } })
})

describe('POST /api/room/sessions/[id]/devices', () => {
  it('rejects unauthenticated requests', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makeRequest({}), makeParams('session-1'))
    expect(res.status).toBe(401)
  })

  it('rejects a non-owner', async () => {
    sessionResult = { data: { ...SESSION_ROW, cases: { id: 'case-1', user_id: 'someone-else' } } }
    const res = await POST(makeRequest({}), makeParams('session-1'))
    expect(res.status).toBe(403)
  })

  it('pairs a device and returns the plaintext token exactly once', async () => {
    const res = await POST(makeRequest({ label: 'Living room Pi' }), makeParams('session-1'))
    expect(res.status).toBe(200)
    const body = await res.json() as { deviceId: string; token: string; label: string | null }
    expect(body.deviceId).toBe('device-1')
    expect(body.token).toBe('fixed-test-token')
  })

  it('stores only the hash of the token, never the plaintext', async () => {
    await POST(makeRequest({ label: 'Living room Pi' }), makeParams('session-1'))
    const inserted = insertedRows[0] as { device_token_hash: string; label: string }
    expect(inserted.device_token_hash).not.toBe('fixed-test-token')
    expect(inserted.device_token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(inserted.label).toBe('Living room Pi')
  })

  it('rejects a label that is too long', async () => {
    const res = await POST(makeRequest({ label: 'x'.repeat(200) }), makeParams('session-1'))
    expect(res.status).toBe(422)
  })

  it('allows pairing with no body at all', async () => {
    const res = await POST(makeRequest(undefined), makeParams('session-1'))
    expect(res.status).toBe(200)
  })
})

describe('GET /api/room/sessions/[id]/devices', () => {
  it('rejects unauthenticated requests', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await GET(makeRequest(), makeParams('session-1'))
    expect(res.status).toBe(401)
  })

  it('lists paired devices without ever including a token', async () => {
    listResult = {
      data: [{ id: 'device-1', label: 'Living room Pi', paired_at: '2026-01-01T00:00:00Z', last_seen_at: null, revoked_at: null }],
    }
    const res = await GET(makeRequest(), makeParams('session-1'))
    expect(res.status).toBe(200)
    const body = await res.json() as { devices: Array<Record<string, unknown>> }
    expect(body.devices).toHaveLength(1)
    expect(body.devices[0]).not.toHaveProperty('token')
    expect(body.devices[0]).not.toHaveProperty('device_token_hash')
  })
})
