import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireRoomSessionAccess, isAccessError } from '@/lib/room/getSession'

/**
 * Lightweight polling endpoint so the client can recover mediation state (current
 * issue, pending agreements, stage) after a reconnect without losing context.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const access = await requireRoomSessionAccess(req, id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  const db = getServiceClient()

  const [{ data: currentIssue }, { data: pendingAgreements }] = await Promise.all([
    access.session.current_issue_id
      ? db.from('room_issues').select('id, title, status').eq('id', access.session.current_issue_id).single()
      : Promise.resolve({ data: null }),
    db.from('room_agreements').select('id, description, agreed_by, awaiting, confirmed').eq('session_id', id).eq('confirmed', false),
  ])

  return NextResponse.json({
    stage: access.session.stage,
    conversationSummary: access.session.conversation_summary,
    currentIssue,
    pendingAgreements: pendingAgreements ?? [],
    realtimeSessionActive: access.session.realtime_session_active,
  })
}
