import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { bearerToken, resolveDeviceByToken } from '@/lib/room/getSession'

/**
 * What should this device be doing right now?
 *
 * The one endpoint a persistent hardware client polls while idle. Device bearer
 * auth, no session required — an idle device has no session, which is precisely
 * why it is asking.
 *
 * Polling (rather than the device being pushed a job) is deliberate: the device
 * sits on a home network behind NAT with no inbound reachability, and a poll that
 * fails is self-healing on the next tick. It doubles as the liveness signal that
 * lets the owner's ready screen show the device as online, because
 * resolveDeviceByToken touches last_seen_at on every call.
 */
export async function GET(req: NextRequest) {
  const token = bearerToken(req)
  if (!token) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  const device = await resolveDeviceByToken(token)
  if (!device) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  if (!device.sessionId) {
    return NextResponse.json({ sessionId: null, label: null, topic: null, stage: null })
  }

  const db = getServiceClient()
  const { data: session } = await db
    .from('room_sessions')
    .select('id, stage, topic')
    .eq('id', device.sessionId)
    .single()

  // Assigned to a session that has since finished or vanished: report idle rather
  // than handing the device work it would only fail at. The owner's next
  // assignment will pick it up.
  if (!session || session.stage === 'completed') {
    return NextResponse.json({ sessionId: null, label: null, topic: null, stage: session?.stage ?? null })
  }

  return NextResponse.json({
    sessionId: session.id,
    topic: session.topic,
    stage: session.stage,
  })
}
