import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireRoomSessionById, isAccessError } from '@/lib/room/getSession'
import { generateSecureToken, hashToken } from '@/lib/tokens'
import { PairRoomDeviceSchema } from '@/lib/validation/schemas'

/**
 * Pairs a new hardware client (e.g. a Raspberry Pi) to this room session. Owner
 * (cookie) auth only — only the session owner can authorize a new device. The
 * returned token is shown exactly once here; only its hash is ever stored.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const access = await requireRoomSessionById(id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  let body: unknown = {}
  try {
    body = await req.json()
  } catch {
    // Body is optional — an empty pairing request is valid.
  }

  const parsed = PairRoomDeviceSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  const token = generateSecureToken()
  const db = getServiceClient()

  const { data: deviceRow, error } = await db
    .from('room_devices')
    .insert({
      session_id: id,
      case_id: access.caseId,
      device_token_hash: hashToken(token),
      label: parsed.data.label ?? null,
    })
    .select('id, label, paired_at')
    .single()

  if (error || !deviceRow) {
    console.error('[room/devices] Failed to pair device:', error?.message)
    return NextResponse.json({ error: 'Failed to pair device.' }, { status: 500 })
  }

  return NextResponse.json({
    deviceId: deviceRow.id,
    label: deviceRow.label,
    pairedAt: deviceRow.paired_at,
    // Returned once — store it on the device now. It cannot be retrieved again;
    // pair a new device instead if it's lost.
    token,
  })
}

/** Lists devices paired to this session (owner only). Never returns token values. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const access = await requireRoomSessionById(id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  const db = getServiceClient()
  const { data: devices } = await db
    .from('room_devices')
    .select('id, label, paired_at, last_seen_at, revoked_at')
    .eq('session_id', id)
    .order('paired_at', { ascending: false })

  return NextResponse.json({ devices: devices ?? [] })
}
