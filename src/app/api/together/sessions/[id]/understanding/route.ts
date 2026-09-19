import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { generateSharedUnderstanding } from '@/lib/ai/together/sharedUnderstanding'
import { getEffectiveSettings } from '@/lib/conversation/getSettings'
import type { DbTogetherTurnSummary } from '@/lib/db/types'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  const db = getServiceClient()

  const { data: session } = await db
    .from('together_sessions')
    .select('id, stage, person_a_name, person_b_name, topic, case_id, cases!inner(user_id)')
    .eq('id', id)
    .single()

  if (!session) return NextResponse.json({ error: 'Session not found.' }, { status: 404 })

  type S = typeof session & { cases: { user_id: string } }
  if ((session as S).cases.user_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
  }

  if (session.stage !== 'sharing_confirmation') {
    return NextResponse.json({ error: 'Session must be in sharing_confirmation stage.' }, { status: 409 })
  }

  // Return existing if already generated
  const { data: existingSession } = await db
    .from('together_sessions')
    .select('shared_understanding')
    .eq('id', id)
    .single()

  if (existingSession?.shared_understanding) {
    await db.from('together_sessions').update({ stage: 'shared_understanding' }).eq('id', id)
    return NextResponse.json({ understanding: existingSession.shared_understanding })
  }

  // Gather all approved summaries
  const { data: summaries } = await db
    .from('together_turn_summaries')
    .select('speaker, round_number, approved_summary, ai_summary')
    .eq('session_id', id)
    .order('round_number')

  const aSummaries = (summaries ?? [])
    .filter(s => s.speaker === 'person_a')
    .map(s => ({ round: s.round_number, summary: (s as DbTogetherTurnSummary).approved_summary ?? s.ai_summary }))

  const bSummaries = (summaries ?? [])
    .filter(s => s.speaker === 'person_b')
    .map(s => ({ round: s.round_number, summary: (s as DbTogetherTurnSummary).approved_summary ?? s.ai_summary }))

  if (aSummaries.length === 0 || bSummaries.length === 0) {
    return NextResponse.json({ error: 'Both participants must have approved summaries before generating shared understanding.' }, { status: 422 })
  }

  const settings = await getEffectiveSettings(session.case_id)

  let result
  try {
    result = await generateSharedUnderstanding({
      personAName: session.person_a_name,
      personBName: session.person_b_name,
      topic: session.topic,
      personASummaries: aSummaries,
      personBSummaries: bSummaries,
      settings,
    })
  } catch (err) {
    console.error('[together/understanding] AI failed:', err)
    return NextResponse.json({ error: 'Failed to generate shared understanding. Please try again.' }, { status: 500 })
  }

  // Store understanding and seed issues table
  await db.from('together_sessions').update({
    shared_understanding: result.understanding,
    stage: 'shared_understanding',
  }).eq('id', id)

  // Insert extracted issues
  if (result.understanding.issues.length > 0) {
    await db.from('together_issues').insert(
      result.understanding.issues.map(issue => ({
        session_id: id,
        case_id: session.case_id,
        title: issue.title,
        neutral_description: issue.neutralDescription,
        priority: issue.priority,
      }))
    )
  }

  // Log token usage
  if (result.inputTokens > 0 || result.outputTokens > 0) {
    void db.rpc('increment_case_token_usage', {
      p_case_id: session.case_id,
      p_input_tokens: result.inputTokens,
      p_output_tokens: result.outputTokens,
    }).then(({ error }) => {
      if (error) console.error('[together/understanding] Token usage error:', error)
    })
  }

  await db.from('audit_events').insert({
    case_id: session.case_id,
    event_type: 'together_shared_understanding_generated',
  })

  return NextResponse.json({ understanding: result.understanding })
}
