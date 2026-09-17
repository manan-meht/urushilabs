import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireRoomSessionAccess, isAccessError } from '@/lib/room/getSession'
import type { DbRoomParticipant } from '@/lib/db/types'

/**
 * Lists this session's participants. Device-or-owner auth (requireRoomSessionAccess) —
 * a hardware client needs this to resolve participant IDs for calibration; the browser
 * currently gets this server-side as page props (see /room/[reference]/live/page.tsx),
 * which isn't available to a non-browser client.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const access = await requireRoomSessionAccess(req, id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  const db = getServiceClient()
  const { data: participants } = await db
    .from('room_participants')
    .select('id, name, participant_index, speaker_label')
    .eq('session_id', id)
    .order('participant_index')

  return NextResponse.json({
    participants: ((participants ?? []) as DbRoomParticipant[]).map((p) => ({
      id: p.id,
      name: p.name,
      participantIndex: p.participant_index,
      speakerLabel: p.speaker_label,
    })),
  })
}
