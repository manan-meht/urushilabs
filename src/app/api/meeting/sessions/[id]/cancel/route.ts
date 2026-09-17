import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireMeetingSessionById, isAccessError } from '@/lib/meeting/getSession'
import { getMeetingBotProvider } from '@/lib/meeting/providerFactory'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const access = await requireMeetingSessionById(id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  if (['completed', 'cancelled'].includes(access.session.status)) {
    return NextResponse.json({ status: access.session.status })
  }

  const db = getServiceClient()
  const provider = getMeetingBotProvider()

  if (access.session.provider_bot_id && provider.isConfigured()) {
    try {
      await provider.leaveMeeting(access.session.provider_bot_id)
    } catch (err) {
      console.error('[POST meeting/cancel] failed to remove bot:', err)
    }
  }

  await db.from('meeting_sessions').update({ status: 'cancelled', ended_at: new Date().toISOString() }).eq('id', id)

  return NextResponse.json({ status: 'cancelled' })
}
