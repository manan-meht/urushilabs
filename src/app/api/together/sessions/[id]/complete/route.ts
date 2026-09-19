import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { generateFinalReport } from '@/lib/ai/together/finalReport'
import { getEffectiveSettings } from '@/lib/conversation/getSettings'
import type { DbTogetherTurnSummary, TogetherSharedUnderstanding } from '@/lib/db/types'

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
    .select('id, stage, person_a_name, person_b_name, topic, case_id, shared_understanding, cases!inner(user_id)')
    .eq('id', id)
    .single()

  if (!session) return NextResponse.json({ error: 'Session not found.' }, { status: 404 })

  type S = typeof session & { cases: { user_id: string } }
  if ((session as S).cases.user_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
  }

  const validStages = ['shared_understanding', 'issue_discussion', 'final_agreement']
  if (!validStages.includes(session.stage)) {
    return NextResponse.json({ error: 'Session is not ready for final report.' }, { status: 409 })
  }

  // Return existing if already generated
  const { data: existingSession } = await db
    .from('together_sessions')
    .select('final_report')
    .eq('id', id)
    .single()

  if (existingSession?.final_report) {
    await db.from('together_sessions').update({ stage: 'completed' }).eq('id', id)
    return NextResponse.json({ report: existingSession.final_report })
  }

  // Gather all approved summaries
  const { data: summaries } = await db
    .from('together_turn_summaries')
    .select('speaker, approved_summary, ai_summary')
    .eq('session_id', id)
    .order('round_number', { ascending: false })

  const getLatest = (sp: string) => {
    const found = summaries?.find(s => s.speaker === sp)
    return (found as DbTogetherTurnSummary | undefined)?.approved_summary ?? found?.ai_summary ?? ''
  }

  const personASummary = getLatest('person_a')
  const personBSummary = getLatest('person_b')

  const understanding = session.shared_understanding as TogetherSharedUnderstanding | null

  // Gather issue resolutions
  const { data: issues } = await db
    .from('together_issues')
    .select('title, status, resolution, together_issue_options(proposed_by, description, person_a_response, person_b_response)')
    .eq('session_id', id)
    .order('priority')

  const issueResolutions = (issues ?? []).map(issue => {
    const acceptedOption = (issue.together_issue_options as Array<{
      person_a_response: string | null
      person_b_response: string | null
      description: string
    }> | null)?.find(
      opt => opt.person_a_response === 'accept' && opt.person_b_response === 'accept'
    )
    return {
      title: issue.title,
      status: issue.status,
      resolution: issue.resolution ?? acceptedOption?.description,
    }
  })

  // Get all messages for safety assessment context
  const { data: messages } = await db
    .from('together_messages')
    .select('speaker, display_content, content, round_number')
    .eq('session_id', id)
    .order('created_at')
    .limit(50)

  const settings = await getEffectiveSettings(session.case_id)

  let result
  try {
    result = await generateFinalReport({
      personAName: session.person_a_name,
      personBName: session.person_b_name,
      topic: session.topic,
      personASummary,
      personBSummary,
      sharedUnderstandingSummary: understanding
        ? `${understanding.personASummary} ${understanding.personBSummary}`
        : '',
      issueResolutions,
      allMessages: (messages ?? []).map(m => ({
        speaker: m.speaker,
        content: m.display_content ?? m.content,
        round: m.round_number,
      })),
      settings,
    })
  } catch (err) {
    console.error('[together/complete] Final report generation failed:', err)
    return NextResponse.json({ error: 'Failed to generate final report. Please try again.' }, { status: 500 })
  }

  await db.from('together_sessions').update({
    final_report: result.report,
    stage: 'completed',
    completed_at: new Date().toISOString(),
  }).eq('id', id)

  await db.from('cases').update({ status: 'report_ready' }).eq('id', session.case_id)

  // Log token usage
  if (result.inputTokens > 0 || result.outputTokens > 0) {
    void db.rpc('increment_case_token_usage', {
      p_case_id: session.case_id,
      p_input_tokens: result.inputTokens,
      p_output_tokens: result.outputTokens,
    }).then(({ error }) => {
      if (error) console.error('[together/complete] Token usage error:', error)
    })
  }

  await db.from('audit_events').insert({
    case_id: session.case_id,
    event_type: 'together_session_completed',
  })

  return NextResponse.json({ report: result.report })
}
