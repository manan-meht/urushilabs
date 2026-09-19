import { NextRequest, NextResponse } from 'next/server'
import { ConversationSettingsSchema, CreateCaseSchema } from '@/lib/validation/schemas'
import { conversationSettingsToRow, normalizeConversationSettings } from '@/lib/conversation/settings'
import { getServiceClient } from '@/lib/db/client'
import { generateSecureToken, hashToken, generatePublicReference, inviteExpiresAt } from '@/lib/tokens'
import { setSessionCookie } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'
import { consumeRoomCredit } from '@/lib/db/credits'
import { extractFirstName } from '@/lib/invitation'

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const parsed = CreateCaseSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  const { recipientName, relationship, topic, consentVersion } = parsed.data

  // Parsed off the raw body rather than folded into CreateCaseSchema: the same
  // block rides on all four create routes, each with its own mode schema.
  const settingsParsed = ConversationSettingsSchema.safeParse(
    (body as { conversationSettings?: unknown }).conversationSettings ?? {}
  )
  if (!settingsParsed.success) {
    return NextResponse.json({ errors: settingsParsed.error.flatten().fieldErrors }, { status: 422 })
  }
  // The normalizer, not the client, decides what is stored.
  const conversationSettings = normalizeConversationSettings(settingsParsed.data)

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

    // Initiator identity comes from the authenticated account, not the form
    const initiatorFullName: string =
      (user.user_metadata?.['full_name'] as string | undefined) ??
      user.email ??
      'Unknown'
    const initiatorName = extractFirstName(initiatorFullName)
    const initiatorEmail = user.email ?? null

    // Check and consume a room credit (creates the free-room record on first use)
    const credited = await consumeRoomCredit(user.id)
    if (!credited) {
      return NextResponse.json(
        { error: 'no_credits', message: 'You have used your free room. Purchase a plan to start more conversations.' },
        { status: 402 }
      )
    }

    const db = getServiceClient()
    const publicReference = generatePublicReference()

    // Generate tokens
    const initiatorToken = generateSecureToken()
    const invitationToken = generateSecureToken()
    const initiatorTokenHash = hashToken(initiatorToken)
    const invitationTokenHash = hashToken(invitationToken)
    const expiresAt = inviteExpiresAt(7)

    // Create the case
    const { data: caseRow, error: caseError } = await db
      .from('cases')
      .insert({
        public_reference: publicReference,
        topic,
        status: 'awaiting_initiator',
        initiator_name: initiatorName,
        recipient_name: recipientName,
        initiator_email: initiatorEmail,
        relationship: relationship ?? null,
        consent_version: consentVersion,
        invitation_token_hash: invitationTokenHash,
        invite_expires_at: expiresAt.toISOString(),
        user_id: user.id,
        ...conversationSettingsToRow(conversationSettings),
      })
      .select('id, public_reference')
      .single()

    if (caseError || !caseRow) {
      console.error('[POST /api/cases] DB error:', caseError?.message)
      return NextResponse.json({ error: 'Failed to create case.' }, { status: 500 })
    }

    // Create the initiator participant record
    const { data: participantRow, error: participantError } = await db
      .from('participants')
      .insert({
        case_id: caseRow.id,
        role: 'initiator',
        display_name: initiatorName,
        email: initiatorEmail,
        access_token_hash: initiatorTokenHash,
        consented_at: new Date().toISOString(),
        user_id: user.id,
      })
      .select('id')
      .single()

    if (participantError || !participantRow) {
      console.error('[POST /api/cases] Participant error:', participantError?.message)
      return NextResponse.json({ error: 'Failed to create participant record.' }, { status: 500 })
    }

    // Audit
    await db.from('audit_events').insert({
      case_id: caseRow.id,
      participant_id: participantRow.id,
      event_type: 'case_created',
      ip_address: req.headers.get('x-forwarded-for') ?? null,
    })

    // Establish session
    await setSessionCookie({
      participantId: participantRow.id,
      caseId: caseRow.id,
      caseReference: caseRow.public_reference,
      role: 'initiator',
      inviteToken: invitationToken,
    })

    const appUrl = process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000'
    const inviteLink = `${appUrl}/invite/${invitationToken}`

    return NextResponse.json({
      caseReference: publicReference,
      caseId: caseRow.id,
      inviteLink,
      recipientName,
    })
  } catch (err) {
    console.error('[POST /api/cases] Unexpected error:', err)
    return NextResponse.json({ error: 'An unexpected error occurred.' }, { status: 500 })
  }
}
