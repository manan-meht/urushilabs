import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { generatePublicReference, generateSecureToken, hashToken } from '@/lib/tokens'
import { consumeRoomCredit } from '@/lib/db/credits'
import { isMeetingMediationEnabled } from '@/lib/featureFlags'
import { CreateMeetingSessionSchema } from '@/lib/validation/schemas'
import { agentSettingsToRow, normalizeAgentSettings } from '@/lib/meeting/agentSettings'
import { extractFirstName } from '@/lib/invitation'
import { trackMeetingEvent, MEETING_ANALYTICS_EVENTS } from '@/lib/analytics/meetingEvents'
import { sendNotification } from '@/lib/notifications'
import { getEnv } from '@/lib/env'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  if (!isMeetingMediationEnabled(user.email)) {
    return NextResponse.json({ error: 'Meeting Mediation is not enabled for this account.' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const parsed = CreateMeetingSessionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  const { participants, topic, contextSummary, agentSettings } = parsed.data
  // Normalizes partial/absent input to complete settings and forces Chair to
  // 'clean' language style regardless of what the client sent (spec §6).
  const resolvedAgentSettings = normalizeAgentSettings(agentSettings)
  const initiatorFirstName = extractFirstName(
    (user.user_metadata?.['full_name'] as string | undefined) ?? user.email ?? 'The organizer'
  )

  try {
    // Shared credit pool with Together Mode / Live Mediation — see src/lib/db/credits.ts.
    const credited = await consumeRoomCredit(user.id)
    if (!credited) {
      return NextResponse.json(
        { error: 'no_credits', message: 'You have used your free room. Purchase a plan to start more conversations.' },
        { status: 402 }
      )
    }

    const db = getServiceClient()
    const publicReference = generatePublicReference()

    const { data: caseRow, error: caseError } = await db
      .from('cases')
      .insert({
        public_reference: publicReference,
        topic,
        status: 'awaiting_initiator',
        initiator_name: participants[0]!.name,
        recipient_name: participants[1]!.name,
        initiator_email: user.email ?? null,
        consent_version: '1.0',
        conversation_mode: 'meeting_mediation',
        user_id: user.id,
      })
      .select('id, public_reference')
      .single()

    if (caseError || !caseRow) {
      console.error('[POST /api/meeting/sessions] Case error:', caseError?.message)
      return NextResponse.json({ error: 'Failed to create case.' }, { status: 500 })
    }

    const { data: sessionRow, error: sessionError } = await db
      .from('meeting_sessions')
      .insert({
        case_id: caseRow.id,
        status: 'awaiting_preparation',
        participant_count: participants.length,
        topic,
        context_summary: contextSummary ?? null,
        ...agentSettingsToRow(resolvedAgentSettings),
      })
      .select('*')
      .single()

    if (sessionError || !sessionRow) {
      console.error('[POST /api/meeting/sessions] Session error:', sessionError?.message)
      return NextResponse.json({ error: 'Failed to create session.' }, { status: 500 })
    }

    const { NEXT_PUBLIC_APP_URL } = getEnv()

    const participantRows = await Promise.all(participants.map(async (p, i) => {
      const isInitiator = p.email.toLowerCase() === (user.email ?? '').toLowerCase()
      const token = generateSecureToken()
      return {
        session_id: sessionRow.id,
        case_id: caseRow.id,
        participant_index: i + 1,
        name: p.name,
        email: p.email,
        is_initiator: isInitiator,
        invite_token_hash: hashToken(token),
        invited_at: new Date().toISOString(),
        _token: token, // stripped before insert
      }
    }))

    const { data: insertedParticipants, error: participantsError } = await db
      .from('meeting_participants')
      .insert(participantRows.map(({ _token, ...row }) => row))
      .select('id, participant_index, name, email, is_initiator')

    if (participantsError || !insertedParticipants) {
      console.error('[POST /api/meeting/sessions] Participants error:', participantsError?.message)
      return NextResponse.json({ error: 'Failed to create participants.' }, { status: 500 })
    }

    // Invite everyone except the initiator to the preparation link.
    for (let i = 0; i < participantRows.length; i++) {
      const row = participantRows[i]!
      if (row.is_initiator) continue
      const prepLink = `${NEXT_PUBLIC_APP_URL}/meeting/prepare/${row._token}`
      void sendNotification({
        template: 'recipient_invitation',
        to: row.email,
        recipientName: extractFirstName(row.name),
        initiatorName: initiatorFirstName,
        topic,
        link: prepLink,
        caseReference: publicReference,
        caseId: caseRow.id,
        channel: 'email',
      }).catch((err) => console.error('[POST /api/meeting/sessions] Notification failed:', err))

      await trackMeetingEvent(db, { caseId: caseRow.id, event: MEETING_ANALYTICS_EVENTS.PARTICIPANT_INVITED, metadata: { participantIndex: row.participant_index } })
    }

    await trackMeetingEvent(db, { caseId: caseRow.id, event: MEETING_ANALYTICS_EVENTS.SELECTED, metadata: { participantCount: participants.length } })
    await trackMeetingEvent(db, {
      caseId: caseRow.id,
      event: MEETING_ANALYTICS_EVENTS.CREATED,
      metadata: {
        participantCount: participants.length,
        // Agent configuration is recorded at creation so intervention behaviour can
        // later be analysed per personality/level (spec §25).
        personality: resolvedAgentSettings.personality,
        interventionLevel: resolvedAgentSettings.interventionLevel,
        region: resolvedAgentSettings.region,
        language: resolvedAgentSettings.language,
        languageStyle: resolvedAgentSettings.languageStyle,
        voiceGender: resolvedAgentSettings.voiceGender,
      },
    })

    return NextResponse.json({
      caseReference: caseRow.public_reference,
      caseId: caseRow.id,
      sessionId: sessionRow.id,
      participants: insertedParticipants,
    })
  } catch (err) {
    console.error('[POST /api/meeting/sessions] Unexpected error:', err)
    return NextResponse.json({ error: 'An unexpected error occurred.' }, { status: 500 })
  }
}
