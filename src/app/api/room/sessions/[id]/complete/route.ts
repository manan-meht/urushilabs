import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireRoomSessionAccess, isAccessError } from '@/lib/room/getSession'
import { generateRoomFinalReport } from '@/lib/ai/room/finalReport'
import { trackRoomEvent, ROOM_ANALYTICS_EVENTS } from '@/lib/analytics/roomEvents'
import type { DbRoomParticipant, DbRoomTranscriptSegment } from '@/lib/db/types'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const access = await requireRoomSessionAccess(req, id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  if (access.session.final_report) {
    return NextResponse.json({ report: access.session.final_report })
  }

  if (access.session.stage !== 'live' && access.session.stage !== 'paused') {
    return NextResponse.json({ error: 'Session is not in progress.' }, { status: 409 })
  }

  const db = getServiceClient()

  const [{ data: participants }, { data: issues }, { data: agreements }, { data: transcript }] = await Promise.all([
    db.from('room_participants').select('*').eq('session_id', id).order('participant_index'),
    db.from('room_issues').select('title, status, resolution').eq('session_id', id).order('priority'),
    db.from('room_agreements').select('description, confirmed').eq('session_id', id).eq('confirmed', true),
    db.from('room_transcript_segments').select('*').eq('session_id', id).order('sequence_number').limit(200),
  ])

  const participantList = (participants ?? []) as DbRoomParticipant[]
  const nameByParticipantId = new Map(participantList.map((p) => [p.id, p.name]))

  let result
  try {
    result = await generateRoomFinalReport({
      topic: access.session.topic,
      contextSummary: access.session.context_summary ?? undefined,
      participantNames: participantList.map((p) => p.name),
      conversationSummary: access.session.conversation_summary ?? 'No summary was captured during the conversation.',
      issueResolutions: (issues ?? []).map((i) => ({ title: i.title, status: i.status, resolution: i.resolution ?? undefined })),
      confirmedAgreements: (agreements ?? []).map((a) => a.description),
      transcriptExcerpt: ((transcript ?? []) as DbRoomTranscriptSegment[]).map((t) => ({
        speakerName: t.role === 'assistant' ? 'Urushi' : (t.participant_id && nameByParticipantId.get(t.participant_id)) || 'Participant',
        content: t.content,
      })),
    })
  } catch (err) {
    console.error('[room/complete] Final report generation failed:', err)
    return NextResponse.json({ error: 'Failed to generate final report. Please try again.' }, { status: 500 })
  }

  const now = new Date().toISOString()
  await db.from('room_sessions').update({
    final_report: result.report,
    stage: 'completed',
    ended_at: now,
    realtime_session_active: false,
  }).eq('id', id)

  await db.from('cases').update({ status: 'report_ready' }).eq('id', access.caseId)

  await trackRoomEvent(db, {
    caseId: access.caseId,
    event: ROOM_ANALYTICS_EVENTS.COMPLETED,
    metadata: {
      durationSeconds: access.session.started_at
        ? (Date.now() - new Date(access.session.started_at).getTime()) / 1000
        : null,
    },
  })

  return NextResponse.json({ report: result.report })
}
