import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireRoomSessionAccess, isAccessError } from '@/lib/room/getSession'
import { trackRoomEvent, ROOM_ANALYTICS_EVENTS } from '@/lib/analytics/roomEvents'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const access = await requireRoomSessionAccess(req, id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  if (access.session.stage !== 'paused') {
    return NextResponse.json({ error: 'Session is not paused.' }, { status: 409 })
  }

  const db = getServiceClient()
  await db.from('room_sessions').update({ stage: 'live', paused_at: null }).eq('id', id)
  await trackRoomEvent(db, { caseId: access.caseId, event: ROOM_ANALYTICS_EVENTS.RESUMED })

  return NextResponse.json({ stage: 'live' })
}
