import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { verifyTogetherAccess } from '@/lib/together/verifyAccess'
import { TogetherOptionResponseSchema } from '@/lib/validation/schemas'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; issueId: string; optionId: string }> }
) {
  const { id, optionId } = await params

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const parsed = TogetherOptionResponseSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  // Accepting or rejecting a proposal is the single most consequential act in
  // this flow — it is what the final report treats as agreement. It previously
  // authenticated the case owner and took `speaker` from the body, so Person A
  // could record person_b_response: 'accept' and the report would show Person B
  // agreeing to something they never saw.
  const access = await verifyTogetherAccess(id)
  if (!access) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  const { speaker, response, note } = parsed.data
  if (speaker !== access.speaker) {
    return NextResponse.json(
      { error: 'You can only respond to a proposal as yourself.' },
      { status: 403 }
    )
  }

  const db = getServiceClient()

  const { data: session } = await db
    .from('together_sessions')
    .select('id')
    .eq('id', id)
    .single()

  if (!session) return NextResponse.json({ error: 'Session not found.' }, { status: 404 })

  const updateField = speaker === 'person_a'
    ? { person_a_response: response, person_a_note: note ?? null }
    : { person_b_response: response, person_b_note: note ?? null }

  const { error } = await db
    .from('together_issue_options')
    .update(updateField)
    .eq('id', optionId)
    .eq('session_id', id)

  if (error) {
    return NextResponse.json({ error: 'Failed to record response.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
