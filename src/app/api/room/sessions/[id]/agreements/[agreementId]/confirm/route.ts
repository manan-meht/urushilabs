import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireRoomSessionById, isAccessError } from '@/lib/room/getSession'
import { RoomAgreementConfirmSchema } from '@/lib/validation/schemas'
import { affirmAgreement } from '@/lib/ai/room/roomState'
import type { DbRoomAgreement } from '@/lib/db/types'

/**
 * Records one participant's explicit affirmation of a proposed agreement.
 * Never inferred from silence — see spec §19.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; agreementId: string }> }
) {
  const { id, agreementId } = await params

  const access = await requireRoomSessionById(id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const parsed = RoomAgreementConfirmSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  const db = getServiceClient()

  const { data: agreement } = await db
    .from('room_agreements')
    .select('*')
    .eq('id', agreementId)
    .eq('session_id', id)
    .single()

  if (!agreement) return NextResponse.json({ error: 'Agreement not found.' }, { status: 404 })

  const row = agreement as DbRoomAgreement
  const result = affirmAgreement(
    { agreedBy: row.agreed_by, awaiting: row.awaiting },
    parsed.data.participantId
  )

  const { error } = await db
    .from('room_agreements')
    .update({
      agreed_by: result.agreedBy,
      awaiting: result.awaiting,
      confirmed: result.confirmed,
      confirmed_at: result.confirmed ? new Date().toISOString() : null,
    })
    .eq('id', agreementId)

  if (error) {
    console.error('[room/agreements/confirm] DB error:', error.message)
    return NextResponse.json({ error: 'Failed to record affirmation.' }, { status: 500 })
  }

  return NextResponse.json(result)
}
