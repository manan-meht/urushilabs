import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { parseRuntimeState } from '@/lib/meeting/runtimeState'
import { verifyStatusTile } from '@/lib/meeting/statusTile'

export const dynamic = 'force-dynamic'

/**
 * What the bot's camera tile polls.
 *
 * Public by necessity — the bot's browser has no session of ours — so the
 * signature in the path is the whole credential, and a bad one gets a 404 that
 * is indistinguishable from a session that does not exist. What it returns is
 * three words and a timestamp, which is all a leaked URL could ever show.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string; sig: string }> }
) {
  const { sessionId, sig } = await params
  if (!verifyStatusTile(sessionId, sig)) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  }

  const db = getServiceClient()
  const { data } = await db
    .from('meeting_sessions')
    .select('runtime_state, status')
    .eq('id', sessionId)
    .maybeSingle()

  if (!data) return NextResponse.json({ error: 'Not found.' }, { status: 404 })

  const state = parseRuntimeState((data as { runtime_state?: unknown }).runtime_state)
  return NextResponse.json(
    {
      status: state.botStatus ?? 'listening',
      at: state.botStatusAt ?? null,
      meeting: (data as { status?: string }).status ?? null,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
