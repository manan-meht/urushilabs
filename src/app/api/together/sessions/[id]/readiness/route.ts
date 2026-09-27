import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { verifyTogetherAccess } from '@/lib/together/verifyAccess'
import { TogetherReadinessSchema } from '@/lib/validation/schemas'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const parsed = TogetherReadinessSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  // The actor comes from WHO IS AUTHENTICATED, never from the request body.
  //
  // This route previously authenticated the case owner and then trusted
  // `speaker` from the body, so Person A could POST {speaker:'person_b'} and
  // confirm on Person B's behalf that Person B was ready to proceed. Person B,
  // authenticated by their own participant cookie, could not call it at all —
  // exactly inverted. verifyTogetherAccess already resolves the real speaker and
  // is what the messages route has always used.
  const access = await verifyTogetherAccess(id)
  if (!access) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  const { speaker } = parsed.data
  if (speaker !== access.speaker) {
    return NextResponse.json(
      { error: 'You can only confirm readiness for yourself.' },
      { status: 403 }
    )
  }

  const db = getServiceClient()

  const { data: session } = await db
    .from('together_sessions')
    .select('id, stage, person_a_ready_confirmed_at, person_b_ready_confirmed_at, case_id')
    .eq('id', id)
    .single()

  if (!session) return NextResponse.json({ error: 'Session not found.' }, { status: 404 })

  // Readiness can be confirmed during any sharing/summary stage or sharing_confirmation
  const validStages = [
    'person_a_sharing', 'person_a_summary_review',
    'person_b_sharing', 'person_b_summary_review',
    'sharing_confirmation',
  ]
  if (!validStages.includes(session.stage)) {
    return NextResponse.json({ error: 'Cannot confirm readiness at this stage.' }, { status: 409 })
  }

  const now = new Date().toISOString()
  const updateField = speaker === 'person_a' ? 'person_a_ready_confirmed_at' : 'person_b_ready_confirmed_at'

  await db.from('together_sessions').update({ [updateField]: now }).eq('id', id)

  // Re-fetch to check if both confirmed
  const { data: updated } = await db
    .from('together_sessions')
    .select('person_a_ready_confirmed_at, person_b_ready_confirmed_at')
    .eq('id', id)
    .single()

  const bothReady = !!(updated?.person_a_ready_confirmed_at && updated?.person_b_ready_confirmed_at)

  if (bothReady && session.stage !== 'sharing_confirmation') {
    await db.from('together_sessions').update({ stage: 'sharing_confirmation' }).eq('id', id)
  }

  await db.from('audit_events').insert({
    case_id: session.case_id,
    event_type: `together_${speaker}_ready_confirmed`,
  })

  return NextResponse.json({ bothReady })
}
