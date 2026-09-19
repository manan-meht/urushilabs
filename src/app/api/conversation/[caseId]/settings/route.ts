import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import {
  conversationSettingsFromRow,
  conversationSettingsToRow,
  normalizeConversationSettings,
} from '@/lib/conversation/settings'
import { proposeSettingsChange } from '@/lib/conversation/acceptance'
import { getConversationSettings } from '@/lib/conversation/getSettings'
import { expectedRefsForCase } from '@/lib/conversation/participants'
import { ConversationSettingsPatchSchema } from '@/lib/validation/schemas'

/**
 * Read and change a conversation's language, style and profanity setting.
 *
 * Works for every mode — the settings live on `cases`, which all four modes hang
 * off — so there is one endpoint rather than four that drift.
 *
 * Changing anything acceptance-relevant bumps the settings version, which
 * invalidates every prior acceptance. The conversation keeps running under the
 * previously accepted settings until everyone agrees to the new ones; see
 * activeSettingsDuringProposal.
 */

async function authorizeCase(caseId: string): Promise<{ userId: string } | { error: string; status: number }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized.', status: 401 }

  const db = getServiceClient()
  const { data: caseRow } = await db.from('cases').select('id, user_id').eq('id', caseId).maybeSingle()
  if (!caseRow) return { error: 'Not found.', status: 404 }
  if (caseRow.user_id !== user.id) return { error: 'Forbidden.', status: 403 }

  return { userId: user.id }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params

  const auth = await authorizeCase(caseId)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const expectedRefs = await expectedRefsForCase(caseId)
  const { configured, effective, acceptance } = await getConversationSettings(caseId, expectedRefs)

  return NextResponse.json({ configured, effective, acceptance })
}

/**
 * Proposes a settings change.
 *
 * Deliberately not an immediate apply: the new settings are written, the version
 * is bumped, and they take effect only once everyone has accepted. The one
 * exception is turning profanity OFF, which applies immediately — withdrawing a
 * permission you granted needs nobody else's agreement, and making someone wait
 * to stop being sworn at would be absurd.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params

  const auth = await authorizeCase(caseId)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const parsed = ConversationSettingsPatchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  const db = getServiceClient()
  const { data: caseRow } = await db
    .from('cases')
    .select('conversation_language, mediator_personality, allow_profanity, text_script, conversation_settings_version')
    .eq('id', caseId)
    .single()

  const current = conversationSettingsFromRow(caseRow)
  // proposeSettingsChange owns the version bump and the profanity/personality
  // invariant; normalize again afterwards so nothing unvalidated can survive the
  // merge.
  const next = normalizeConversationSettings(proposeSettingsChange(current, parsed.data))

  const { error } = await db.from('cases').update(conversationSettingsToRow(next)).eq('id', caseId)
  if (error) {
    console.error('[conversation/settings] Failed to update settings:', error.message)
    return NextResponse.json({ error: 'Failed to update settings.' }, { status: 500 })
  }

  const expectedRefs = await expectedRefsForCase(caseId)
  const { configured, effective, acceptance } = await getConversationSettings(caseId, expectedRefs)

  return NextResponse.json({
    configured,
    effective,
    acceptance,
    // True when the change needs everyone to agree again before it takes effect.
    awaitingAcceptance: next.version !== current.version && !acceptance.allAccepted,
  })
}
