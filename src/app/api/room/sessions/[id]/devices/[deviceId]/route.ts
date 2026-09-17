import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireRoomSessionById, isAccessError } from '@/lib/room/getSession'

/**
 * Revokes a paired device. Owner (cookie) auth only. Revocation is immediate —
 * the device's token stops resolving on its very next request.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; deviceId: string }> }
) {
  const { id, deviceId } = await params

  const access = await requireRoomSessionById(id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  const db = getServiceClient()

  const { data: device } = await db
    .from('room_devices')
    .select('id, session_id')
    .eq('id', deviceId)
    .single()

  if (!device || device.session_id !== id) {
    return NextResponse.json({ error: 'Device not found.' }, { status: 404 })
  }

  const { error } = await db
    .from('room_devices')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', deviceId)

  if (error) {
    console.error('[room/devices] Failed to revoke device:', error.message)
    return NextResponse.json({ error: 'Failed to revoke device.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
