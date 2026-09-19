import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { requireRoomSessionById, isAccessError } from '@/lib/room/getSession'

/**
 * Points a persistent device at a session, or releases it.
 *
 * This is the "Start" button behind the ready screen: the owner assigns their
 * device here, the device discovers it by polling GET /api/room/device/assignment,
 * and joins on its own. No SSH, no token copying, no manual launch.
 *
 * Owner (cookie) auth only, and doubly checked — the caller must own both the
 * device and the session. A device token cannot assign itself anywhere.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const { deviceId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  let body: { sessionId?: unknown } = {}
  try {
    body = await req.json() as { sessionId?: unknown }
  } catch {
    // Empty body means "release this device".
  }

  const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null

  const db = getServiceClient()

  const { data: device } = await db
    .from('room_devices')
    .select('id, user_id, session_id')
    .eq('id', deviceId)
    .is('revoked_at', null)
    .single()

  if (!device) return NextResponse.json({ error: 'Device not found.' }, { status: 404 })
  if (device.user_id !== user.id) return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })

  // Releasing needs no session checks.
  if (!sessionId) {
    await db.from('room_devices').update({ session_id: null, case_id: null }).eq('id', deviceId)
    return NextResponse.json({ deviceId, sessionId: null })
  }

  // Assigning does: the device must not become a way to reach someone else's
  // session, so the caller has to own that session too.
  const access = await requireRoomSessionById(sessionId)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  if (access.session.stage === 'completed') {
    return NextResponse.json({ error: 'Session is already completed.' }, { status: 409 })
  }

  const { error } = await db
    .from('room_devices')
    .update({ session_id: sessionId, case_id: access.caseId })
    .eq('id', deviceId)

  if (error) {
    // The partial unique index on session_id is what surfaces here: one hardware
    // device per session, so a second assignment is a conflict rather than a
    // silent double-join with two microphones in one room.
    console.error('[room/devices/assign] Failed to assign device:', error.message)
    return NextResponse.json(
      { error: 'Another device is already assigned to this session.' },
      { status: 409 }
    )
  }

  return NextResponse.json({ deviceId, sessionId })
}
