import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { getServiceClient } from '@/lib/db/client'
import { generateIntakeSummary } from '@/lib/ai/intake'
import { getEffectiveSettings } from '@/lib/conversation/getSettings'

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const transcript = (body as { transcript?: string }).transcript
  if (!transcript || typeof transcript !== 'string') {
    return NextResponse.json({ error: 'Transcript is required.' }, { status: 422 })
  }

  const db = getServiceClient()
  const { data: caseRow } = await db
    .from('cases')
    .select('topic, initiator_name, recipient_name')
    .eq('id', session.caseId)
    .single()

  if (!caseRow) {
    return NextResponse.json({ error: 'Case not found.' }, { status: 404 })
  }

  const participantName =
    session.role === 'initiator' ? caseRow.initiator_name : caseRow.recipient_name
  const otherPartyName =
    session.role === 'initiator' ? caseRow.recipient_name : caseRow.initiator_name

  // Intake is private and single-party, so nobody else's acceptance is
  // outstanding — the default empty expectation list is correct here.
  const settings = await getEffectiveSettings(session.caseId)

  try {
    const result = await generateIntakeSummary(
      { participantName, role: session.role, topic: caseRow.topic, otherPartyName, settings },
      transcript
    )

    if (result.inputTokens > 0 || result.outputTokens > 0) {
      void (async () => {
        try {
          const { error } = await db.rpc('increment_case_token_usage', {
            p_case_id: session.caseId,
            p_input_tokens: result.inputTokens,
            p_output_tokens: result.outputTokens,
          })
          if (error) console.error('[intake/summary] token usage update failed:', error)
        } catch (err) { console.error('[intake/summary] token usage update threw:', err) }
      })()
    }

    return NextResponse.json({ summary: result.content })
  } catch (err) {
    console.error('[POST /api/intake/summary]', err)
    return NextResponse.json({ error: 'Failed to generate summary.' }, { status: 500 })
  }
}
