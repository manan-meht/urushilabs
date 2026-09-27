import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { verifyTogetherAccess } from '@/lib/together/verifyAccess'
import { TogetherSummaryApprovalSchema } from '@/lib/validation/schemas'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; summaryId: string }> }
) {
  const { id, summaryId } = await params

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const parsed = TogetherSummaryApprovalSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  const { approvedSummary } = parsed.data

  const access = await verifyTogetherAccess(id)
  if (!access) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  const db = getServiceClient()

  const { data: session } = await db
    .from('together_sessions')
    .select('id, stage, current_speaker, round_number, case_id, person_a_name, person_b_name')
    .eq('id', id)
    .single()

  if (!session) return NextResponse.json({ error: 'Session not found.' }, { status: 404 })

  const validStages = ['person_a_summary_review', 'person_b_summary_review']
  if (!validStages.includes(session.stage)) {
    return NextResponse.json({ error: 'Not in a summary review stage.' }, { status: 409 })
  }

  // Only the person whose account was summarised may approve that summary, and
  // the stage says whose it is.
  //
  // This route previously authenticated the case owner alone, so Person A could
  // approve Person B's summary of what Person B had said — editing it first, via
  // `approvedSummary`. That summary is what the shared report is built from, so
  // it let one participant author the other's account of the dispute and sign
  // off on it. Person B could not approve their own.
  const summarySubject = session.stage === 'person_a_summary_review' ? 'person_a' : 'person_b'
  if (access.speaker !== summarySubject) {
    return NextResponse.json(
      { error: 'Only the person being summarised can approve their own summary.' },
      { status: 403 }
    )
  }

  // Update the summary
  const { error: summaryError } = await db
    .from('together_turn_summaries')
    .update({ approved_summary: approvedSummary, approved_at: new Date().toISOString() })
    .eq('id', summaryId)
    .eq('session_id', id)

  if (summaryError) {
    console.error('[together/summaries/approve] DB error:', summaryError.message)
    return NextResponse.json({ error: 'Failed to approve summary.' }, { status: 500 })
  }

  // Determine next stage
  // person_a approved → switch to person_b_sharing (same round if first time person_b,
  //   or person_b already went this round → sharing_confirmation / next round depends on context)
  // person_b approved → check if both want to continue or move to sharing_confirmation
  let nextStage: string
  let nextSpeaker: string | null = null
  const nextRound = session.round_number

  if (session.stage === 'person_a_summary_review') {
    // Person A reviewed → show Person B their summary on same device
    nextStage = 'person_b_summary_review'
    nextSpeaker = null
  } else {
    // Both summaries reviewed → let both confirm they feel heard before moving on
    nextStage = 'sharing_confirmation'
    nextSpeaker = null
  }

  await db
    .from('together_sessions')
    .update({ stage: nextStage, current_speaker: nextSpeaker, round_number: nextRound })
    .eq('id', id)

  await db.from('audit_events').insert({
    case_id: session.case_id,
    event_type: `together_summary_approved`,
    metadata: { stage: session.stage, round: session.round_number },
  })

  return NextResponse.json({ nextStage, nextSpeaker, nextRound })
}
