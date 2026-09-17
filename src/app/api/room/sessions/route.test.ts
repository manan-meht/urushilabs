import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockConsumeRoomCredit = vi.fn()
const mockTrackRoomEvent = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: () => mockGetUser() } }),
}))

vi.mock('@/lib/db/credits', () => ({
  consumeRoomCredit: (userId: string) => mockConsumeRoomCredit(userId),
}))

vi.mock('@/lib/featureFlags', () => ({
  isLiveMediationEnabled: () => true,
}))

vi.mock('@/lib/analytics/roomEvents', () => ({
  trackRoomEvent: (...args: unknown[]) => mockTrackRoomEvent(...args),
  ROOM_ANALYTICS_EVENTS: { SETUP_STARTED: 'live_mediation_setup_started' },
}))

vi.mock('@/lib/tokens', () => ({
  generatePublicReference: () => 'REF123',
}))

function makeQueryBuilder(result: { data: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {}
  const chain = ['insert', 'select', 'eq', 'order', 'limit', 'update']
  for (const method of chain) {
    builder[method] = vi.fn(() => builder)
  }
  builder['single'] = vi.fn(async () => result)
  builder['maybeSingle'] = vi.fn(async () => result)
  ;(builder as { then: PromiseLike<unknown>['then'] }).then = (resolve, reject) =>
    Promise.resolve(result).then(resolve, reject)
  return builder
}

let participantsResult: { data: unknown; error?: unknown }

vi.mock('@/lib/db/client', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      if (table === 'cases') {
        return makeQueryBuilder({ data: { id: 'case-1', public_reference: 'REF123' } })
      }
      if (table === 'room_sessions') {
        return makeQueryBuilder({ data: { id: 'session-1' } })
      }
      if (table === 'room_participants') {
        return makeQueryBuilder(participantsResult)
      }
      return makeQueryBuilder({ data: null })
    },
  }),
}))

import { POST } from './route'

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as import('next/server').NextRequest
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@example.com' } } })
  mockConsumeRoomCredit.mockResolvedValue(true)
  participantsResult = {
    data: [
      { id: 'p1', participant_index: 1, name: 'Manan' },
      { id: 'p2', participant_index: 2, name: 'Sonam' },
    ],
  }
})

describe('POST /api/room/sessions', () => {
  it('rejects unauthenticated requests', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makeRequest({ participantNames: ['A', 'B'], topic: 'Something to discuss' }))
    expect(res.status).toBe(401)
  })

  it('rejects fewer than 2 participants', async () => {
    const res = await POST(makeRequest({ participantNames: ['Manan'], topic: 'Something to discuss' }))
    expect(res.status).toBe(422)
  })

  it('rejects more than 3 participants', async () => {
    const res = await POST(makeRequest({ participantNames: ['A', 'B', 'C', 'D'], topic: 'Something to discuss' }))
    expect(res.status).toBe(422)
  })

  it('creates a session for 2 participants', async () => {
    const res = await POST(makeRequest({ participantNames: ['Manan', 'Sonam'], topic: 'Division of responsibilities' }))
    expect(res.status).toBe(200)
    const body = await res.json() as { caseReference: string; participants: unknown[] }
    expect(body.caseReference).toBe('REF123')
    expect(body.participants).toHaveLength(2)
  })

  it('creates a session for 3 participants', async () => {
    participantsResult = {
      data: [
        { id: 'p1', participant_index: 1, name: 'Manan' },
        { id: 'p2', participant_index: 2, name: 'Sonam' },
        { id: 'p3', participant_index: 3, name: 'Rahul' },
      ],
    }
    const res = await POST(makeRequest({ participantNames: ['Manan', 'Sonam', 'Rahul'], topic: 'Family business decisions' }))
    expect(res.status).toBe(200)
    const body = await res.json() as { participants: unknown[] }
    expect(body.participants).toHaveLength(3)
  })

  it('returns 402 when the user has no room credits', async () => {
    mockConsumeRoomCredit.mockResolvedValue(false)
    const res = await POST(makeRequest({ participantNames: ['Manan', 'Sonam'], topic: 'Division of responsibilities' }))
    expect(res.status).toBe(402)
  })

  it('rejects a topic that is too short', async () => {
    const res = await POST(makeRequest({ participantNames: ['Manan', 'Sonam'], topic: 'Hi' }))
    expect(res.status).toBe(422)
  })
})
