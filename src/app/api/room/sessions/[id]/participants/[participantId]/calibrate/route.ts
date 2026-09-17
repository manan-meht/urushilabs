import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireRoomSessionAccess, isAccessError } from '@/lib/room/getSession'
import { RoomCalibrateSchema } from '@/lib/validation/schemas'

/**
 * Maps a diarization speaker label (e.g. "A") to a known participant, from the
 * short calibration step at the start of the meeting ("Manan, please say hello").
 * This is deliberately probabilistic — confidence is stored, never treated as fact.
 * No biometric voice profile is stored, only the label mapping for this session.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; participantId: string }> }
) {
  const { id, participantId } = await params

  const access = await requireRoomSessionAccess(req, id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const parsed = RoomCalibrateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  const db = getServiceClient()

  const { data: participant } = await db
    .from('room_participants')
    .select('id, session_id')
    .eq('id', participantId)
    .single()

  if (!participant || participant.session_id !== id) {
    return NextResponse.json({ error: 'Participant not found.' }, { status: 404 })
  }

  const { error } = await db
    .from('room_participants')
    .update({
      speaker_label: parsed.data.diarizationLabel,
      speaker_confidence: parsed.data.confidence ?? null,
      calibrated_at: new Date().toISOString(),
    })
    .eq('id', participantId)

  if (error) {
    console.error('[room/calibrate] DB error:', error.message)
    return NextResponse.json({ error: 'Failed to save calibration.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
