import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { conversationSettingsFromRow } from '@/lib/conversation/settings'
import { SHARED_DEVICE_REF } from '@/lib/conversation/acceptance'
import { getConversationSettings } from '@/lib/conversation/getSettings'
import { expectedRefsForCase } from '@/lib/conversation/participants'
import { AcceptConversationSettingsSchema } from '@/lib/validation/schemas'
import { resolveAcceptingParticipant } from '@/lib/conversation/acceptingParticipant'

/**
 * Records one participant's agreement to — or rejection of — the proposed
 * conversation settings.
 *
 * Two rules this endpoint exists to enforce:
 *
 *  - Acceptance is tied to a settings VERSION. A request carrying a stale
 *    version is rejected rather than recorded, so an agreement gathered under
 *    one configuration can never authorise a different one. This is the reason
 *    the client must send the version it was actually shown.
 *
 *  - Accepting the style is NOT accepting the swearing. `acceptProfanity` is a
 *    separate answer, and profanity only takes effect when everyone has said yes
 *    to it specifically.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const parsed = AcceptConversationSettingsSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  // Who is accepting is resolved from the caller's own credentials, never from
  // the request body — otherwise anyone could accept on someone else's behalf,
  // which is precisely the thing this whole flow exists to prevent.
  const participant = await resolveAcceptingParticipant(req, caseId)
  if ('error' in participant) {
    return NextResponse.json({ error: participant.error }, { status: participant.status })
  }

  const db = getServiceClient()
  const { data: caseRow } = await db
    .from('cases')
    .select('conversation_language, mediator_personality, allow_profanity, text_script, conversation_settings_version')
    .eq('id', caseId)
    .maybeSingle()

  if (!caseRow) return NextResponse.json({ error: 'Not found.' }, { status: 404 })

  const settings = conversationSettingsFromRow(caseRow)

  // A stale version means the settings changed under the participant while they
  // were reading them. Reject rather than record, and hand back the current
  // settings so the client can re-present them.
  if (parsed.data.settingsVersion !== settings.version) {
    return NextResponse.json(
      { error: 'These settings have changed. Please review them again.', settings },
      { status: 409 }
    )
  }

  const now = new Date().toISOString()
  const { error } = await db
    .from('conversation_settings_acceptances')
    .upsert({
      case_id: caseId,
      participant_ref: participant.ref,
      settings_version: settings.version,
      // A decline never carries profanity agreement, regardless of what was sent.
      accepted_profanity: parsed.data.decline ? false : parsed.data.acceptProfanity === true,
      declined_at: parsed.data.decline ? now : null,
      accepted_at: now,
    }, { onConflict: 'case_id,participant_ref,settings_version' })

  if (error) {
    console.error('[conversation/settings/accept] Failed to record acceptance:', error.message)
    return NextResponse.json({ error: 'Failed to record your response.' }, { status: 500 })
  }

  const expectedRefs = await expectedRefsForCase(caseId)
  const resolved = await getConversationSettings(caseId, expectedRefs)

  return NextResponse.json({
    ...resolved,
    // Shared-device confirmations cover everyone present on one tap; the client
    // uses this to word the confirmation honestly rather than implying each
    // person consented individually.
    sharedDevice: participant.ref === SHARED_DEVICE_REF,
  })
}
