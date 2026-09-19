import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { generateSecureToken, hashToken } from '@/lib/tokens'
import { PairRoomDeviceSchema } from '@/lib/validation/schemas'

/**
 * Persistent hardware devices belonging to the signed-in user, independent of any
 * session.
 *
 * The session-scoped equivalent (/api/room/sessions/[id]/devices) pairs a device
 * to one mediation and is useless afterwards. That made every new session cost a
 * re-pair, a token copy and an SSH round trip to the device — untenable for a box
 * that should just sit on a table. Pair here once; assign per session from the
 * ready screen (see ./[deviceId]/assign).
 */

/** Registers a device and returns its token exactly once. */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  let body: unknown = {}
  try {
    body = await req.json()
  } catch {
    // Body is optional — an unlabelled device is valid.
  }

  const parsed = PairRoomDeviceSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  const token = generateSecureToken()
  const db = getServiceClient()

  const { data: device, error } = await db
    .from('room_devices')
    .insert({
      user_id: user.id,
      session_id: null,
      case_id: null,
      device_token_hash: hashToken(token),
      label: parsed.data.label ?? null,
    })
    .select('id, label, paired_at')
    .single()

  if (error || !device) {
    console.error('[room/devices] Failed to register device:', error?.message)
    return NextResponse.json({ error: 'Failed to register device.' }, { status: 500 })
  }

  return NextResponse.json({
    deviceId: device.id,
    label: device.label,
    pairedAt: device.paired_at,
    // Shown once and never retrievable. Register a new device if it's lost.
    token,
  })
}

/**
 * Lists the user's devices, with enough freshness information for the ready
 * screen to show which are actually powered on.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  const db = getServiceClient()
  const { data: devices } = await db
    .from('room_devices')
    .select('id, label, paired_at, last_seen_at, session_id')
    .eq('user_id', user.id)
    .is('revoked_at', null)
    .order('paired_at', { ascending: false })

  return NextResponse.json({ devices: devices ?? [] })
}
