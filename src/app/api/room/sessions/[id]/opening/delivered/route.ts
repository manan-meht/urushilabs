import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireRoomSessionAccess, isAccessError } from '@/lib/room/getSession'

/**
 * Records that Urushi's opening line was actually spoken out loud.
 *
 * The counterpart to POST ../opening, which only generates the words. A client
 * calls this once the audio has demonstrably started playing — not when it
 * received the text, and not when it queued the request. Until this lands, the
 * opening stays unclaimed and a reconnecting client will get a fresh one, which
 * is the whole point: a dropped connection must not be able to silently eat the
 * only introduction the room was ever going to hear.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const access = await requireRoomSessionAccess(req, id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  const body = await req.json().catch(() => ({})) as { spokenText?: unknown }
  const spokenText = typeof body.spokenText === 'string' ? body.spokenText.trim() : ''
  if (!spokenText) {
    return NextResponse.json({ error: 'spokenText is required.' }, { status: 400 })
  }

  const db = getServiceClient()

  // Re-check rather than trust the client. Two clients racing on one session, or
  // a retry after a response that was lost in transit, must not produce two
  // opening turns in the transcript.
  const { count } = await db
    .from('room_transcript_segments')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', id)
    .eq('role', 'assistant')

  if ((count ?? 0) > 0) {
    return NextResponse.json({ recorded: false, alreadyOpened: true })
  }

  const { data: last } = await db
    .from('room_transcript_segments')
    .select('sequence_number')
    .eq('session_id', id)
    .order('sequence_number', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { error } = await db.from('room_transcript_segments').insert({
    session_id: id,
    case_id: access.caseId,
    role: 'assistant',
    content: spokenText,
    sequence_number: (last?.sequence_number ?? 0) + 1,
  })

  if (error) {
    console.error('[room/opening/delivered] insert failed:', error)
    return NextResponse.json({ error: 'Failed to record the opening.' }, { status: 500 })
  }

  return NextResponse.json({ recorded: true, alreadyOpened: false })
}
