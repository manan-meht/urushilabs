import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { generatePublicReference } from '@/lib/tokens'
import { consumeRoomCredit } from '@/lib/db/credits'
import { isLiveMediationEnabled } from '@/lib/featureFlags'
import { CreateRoomSessionSchema } from '@/lib/validation/schemas'
import { trackRoomEvent } from '@/lib/analytics/roomEvents'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  if (!isLiveMediationEnabled(user.email)) {
    return NextResponse.json({ error: 'Live Mediation is not enabled for this account.' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const parsed = CreateRoomSessionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  const { participantNames, topic, contextSummary, sourceCaseReference } = parsed.data

  try {
    const credited = await consumeRoomCredit(user.id)
    if (!credited) {
      return NextResponse.json(
        { error: 'no_credits', message: 'You have used your free room. Purchase a plan to start more conversations.' },
        { status: 402 }
      )
    }

    const db = getServiceClient()

    // Optionally pull background from an existing case instead of asking again.
    let resolvedContext = contextSummary ?? null
    let sourceCaseId: string | null = null
    if (sourceCaseReference) {
      const { data: sourceCase } = await db
        .from('cases')
        .select('id, topic, invitation_brief, user_id')
        .eq('public_reference', sourceCaseReference)
        .single()

      if (sourceCase && sourceCase.user_id === user.id) {
        sourceCaseId = sourceCase.id
        if (!resolvedContext) {
          resolvedContext = sourceCase.invitation_brief ?? sourceCase.topic ?? null
        }
      }
    }

    const publicReference = generatePublicReference()

    const { data: caseRow, error: caseError } = await db
      .from('cases')
      .insert({
        public_reference: publicReference,
        topic,
        status: 'awaiting_initiator',
        initiator_name: participantNames[0],
        recipient_name: participantNames[1],
        initiator_email: user.email ?? null,
        consent_version: '1.0',
        conversation_mode: 'room',
        user_id: user.id,
      })
      .select('id, public_reference')
      .single()

    if (caseError || !caseRow) {
      console.error('[POST /api/room/sessions] Case error:', caseError?.message)
      return NextResponse.json({ error: 'Failed to create case.' }, { status: 500 })
    }

    const { data: sessionRow, error: sessionError } = await db
      .from('room_sessions')
      .insert({
        case_id: caseRow.id,
        stage: 'setup',
        participant_count: participantNames.length,
        topic,
        context_summary: resolvedContext,
        source_case_id: sourceCaseId,
      })
      .select('id')
      .single()

    if (sessionError || !sessionRow) {
      console.error('[POST /api/room/sessions] Session error:', sessionError?.message)
      return NextResponse.json({ error: 'Failed to create session.' }, { status: 500 })
    }

    const { data: participants, error: participantsError } = await db
      .from('room_participants')
      .insert(
        participantNames.map((name, i) => ({
          session_id: sessionRow.id,
          case_id: caseRow.id,
          participant_index: i + 1,
          name,
        }))
      )
      .select('id, participant_index, name')

    if (participantsError || !participants) {
      console.error('[POST /api/room/sessions] Participants error:', participantsError?.message)
      return NextResponse.json({ error: 'Failed to create participants.' }, { status: 500 })
    }

    await trackRoomEvent(db, { caseId: caseRow.id, event: 'live_mediation_setup_started', metadata: { participantCount: participantNames.length } })

    return NextResponse.json({
      caseReference: caseRow.public_reference,
      caseId: caseRow.id,
      sessionId: sessionRow.id,
      participants,
    })
  } catch (err) {
    console.error('[POST /api/room/sessions] Unexpected error:', err)
    return NextResponse.json({ error: 'An unexpected error occurred.' }, { status: 500 })
  }
}
