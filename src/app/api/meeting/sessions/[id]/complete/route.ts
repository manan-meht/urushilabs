import { NextRequest, NextResponse } from 'next/server'
import { requireMeetingSessionById, isAccessError } from '@/lib/meeting/getSession'
import { completeMeetingSession } from '@/lib/meeting/completeSession'

/**
 * Owner-triggered report generation — same idempotent logic the Recall webhook's
 * meeting_ended handler uses (src/lib/meeting/completeSession.ts), exposed here
 * as a manual retry path from the status page.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const access = await requireMeetingSessionById(id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  const result = await completeMeetingSession(id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })

  return NextResponse.json({ report: result.report })
}
