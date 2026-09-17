import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireRoomSessionById, isAccessError } from '@/lib/room/getSession'
import { RoomConsentSchema } from '@/lib/validation/schemas'
import { trackRoomEvent, ROOM_ANALYTICS_EVENTS } from '@/lib/analytics/roomEvents'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const access = await requireRoomSessionById(id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const parsed = RoomConsentSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  if (access.session.stage !== 'setup' && access.session.stage !== 'consent') {
    return NextResponse.json({ error: 'Session is not in setup/consent stage.' }, { status: 409 })
  }

  const db = getServiceClient()
  const now = new Date().toISOString()

  const { error } = await db
    .from('room_sessions')
    .update({ stage: 'ready', consent_completed_at: now })
    .eq('id', id)

  if (error) {
    console.error('[POST room/consent] DB error:', error.message)
    return NextResponse.json({ error: 'Failed to record consent.' }, { status: 500 })
  }

  await trackRoomEvent(db, { caseId: access.caseId, event: ROOM_ANALYTICS_EVENTS.SELECTED, metadata: { step: 'consent_completed' } })

  return NextResponse.json({ stage: 'ready' })
}
