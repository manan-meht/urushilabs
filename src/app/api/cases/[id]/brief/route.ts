import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { getServiceClient } from '@/lib/db/client'
import { decryptSummaryFromDb } from '@/lib/crypto'
import { generateInvitationBrief, INVITATION_BRIEF_VERSION } from '@/lib/ai/invitationBrief'
import { getEffectiveSettings } from '@/lib/conversation/getSettings'
import type { DbSubmission } from '@/lib/db/types'

interface RouteParams {
  params: Promise<{ id: string }>
}

// GET — return the current brief for Party A to preview
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id: caseId } = await params
  const session = await getSession()
  if (!session || session.caseId !== caseId || session.role !== 'initiator') {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const db = getServiceClient()
  const { data: caseRow } = await db
    .from('cases')
    .select('invitation_brief, invitation_brief_approved_at, initiator_name, recipient_name, topic')
    .eq('id', caseId)
    .single()

  if (!caseRow) return NextResponse.json({ error: 'Case not found.' }, { status: 404 })

  return NextResponse.json({
    brief: caseRow.invitation_brief ? JSON.parse(caseRow.invitation_brief) : null,
    approvedAt: caseRow.invitation_brief_approved_at ?? null,
  })
}

// POST — (re)generate the brief from Party A's submission
export async function POST(_req: NextRequest, { params }: RouteParams) {
  const { id: caseId } = await params
  const session = await getSession()
  if (!session || session.caseId !== caseId || session.role !== 'initiator') {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const db = getServiceClient()

  const { data: caseRow } = await db
    .from('cases')
    .select('topic, initiator_name, recipient_name')
    .eq('id', caseId)
    .single()

  if (!caseRow) return NextResponse.json({ error: 'Case not found.' }, { status: 404 })

  // Get Party A's submission
  const { data: submission } = await db
    .from('submissions')
    .select('participant_id, encrypted_summary, encryption_iv, encryption_tag')
    .eq('case_id', caseId)
    .eq('participant_id', session.participantId)
    .order('revision_number', { ascending: false })
    .limit(1)
    .single()

  if (!submission) {
    return NextResponse.json({ error: 'No intake submission found. Please complete your intake first.' }, { status: 422 })
  }

  const initiatorSummaryJson = decryptSummaryFromDb(submission as DbSubmission)

  const settings = await getEffectiveSettings(caseId)

  try {
    const brief = await generateInvitationBrief({
      initiatorName: caseRow.initiator_name,
      recipientName: caseRow.recipient_name,
      topic: caseRow.topic,
      initiatorSummaryJson,
      settings,
    })

    // Store brief, clear any previous approval
    await db
      .from('cases')
      .update({
        invitation_brief: JSON.stringify(brief),
        invitation_brief_approved_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', caseId)

    await db.from('audit_events').insert({
      case_id: caseId,
      participant_id: session.participantId,
      event_type: 'invitation_brief_generated',
      metadata: { version: INVITATION_BRIEF_VERSION },
    })

    return NextResponse.json({ brief })
  } catch (err) {
    console.error('[POST /api/cases/[id]/brief] Error:', err)
    return NextResponse.json({ error: 'Failed to generate invitation brief.' }, { status: 500 })
  }
}
