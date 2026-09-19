import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { generateTurnSummary } from '@/lib/ai/together/turnSummary'
import { getEffectiveSettings } from '@/lib/conversation/getSettings'
import type { DbTogetherMessage, DbTogetherTurnSummary } from '@/lib/db/types'

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
    .select('id, stage, current_speaker, round_number, person_a_name, person_b_name, topic, case_id, cases!inner(user_id)')
    .eq('id', id)
    .single()

  if (!session) return NextResponse.json({ error: 'Session not found.' }, { status: 404 })

  type S = typeof session & { cases: { user_id: string } }
  if ((session as S).cases.user_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
  }

  const validStages = ['person_a_sharing', 'person_b_sharing']
  if (!validStages.includes(session.stage)) {
    return NextResponse.json({ error: 'Not in a sharing stage.' }, { status: 409 })
  }

  const round = session.round_number

  // Fetch all messages this round for both speakers
  const { data: allMessages } = await db
    .from('together_messages')
    .select('id, content, voice_transcript, display_content, speaker')
    .eq('session_id', id)
    .eq('round_number', round)
    .order('created_at')

  const personAMessages = (allMessages ?? []).filter(m => m.speaker === 'person_a')
  const personBMessages = (allMessages ?? []).filter(m => m.speaker === 'person_b')

  if (personAMessages.length === 0 && personBMessages.length === 0) {
    return NextResponse.json({ error: 'No messages to summarise. Please share something first.' }, { status: 422 })
  }

  // Fetch previous approved summaries for context
  const { data: previousSummaries } = await db
    .from('together_turn_summaries')
    .select('speaker, round_number, approved_summary, ai_summary')
    .eq('session_id', id)
    .not('approved_at', 'is', null)
    .order('round_number')

  const prevSummaryContext = (previousSummaries ?? []).map(s => ({
    speaker: s.speaker === 'person_a' ? session.person_a_name : session.person_b_name,
    summary: (s as DbTogetherTurnSummary).approved_summary ?? s.ai_summary,
    round: s.round_number,
  }))

  type MsgRow = Pick<DbTogetherMessage, 'content' | 'voice_transcript' | 'display_content'>
  const toMsgList = (msgs: MsgRow[]) => msgs.map(m => ({
    content: m.display_content ?? m.content,
    isVoice: !!m.voice_transcript,
  }))

  // Generate summaries for both people in parallel, skipping if already exists
  const [aExisting, bExisting] = await Promise.all([
    db.from('together_turn_summaries').select('id, ai_summary').eq('session_id', id).eq('speaker', 'person_a').eq('round_number', round).maybeSingle(),
    db.from('together_turn_summaries').select('id, ai_summary').eq('session_id', id).eq('speaker', 'person_b').eq('round_number', round).maybeSingle(),
  ])

  const settings = await getEffectiveSettings(session.case_id)

  let totalInputTokens = 0
  let totalOutputTokens = 0

  async function ensureSummary(
    speaker: 'person_a' | 'person_b',
    existing: typeof aExisting,
    msgs: MsgRow[],
  ) {
    if (existing.data) return existing.data.id
    if (msgs.length === 0) return null

    const s = session!
    const speakerName = speaker === 'person_a' ? s.person_a_name : s.person_b_name
    const otherName = speaker === 'person_a' ? s.person_b_name : s.person_a_name

    const result = await generateTurnSummary({
      speakerName,
      otherName,
      topic: s.topic,
      roundNumber: round,
      messages: toMsgList(msgs),
      previousSummaries: prevSummaryContext,
      settings,
    })

    totalInputTokens += result.inputTokens
    totalOutputTokens += result.outputTokens

    const { data: row } = await db
      .from('together_turn_summaries')
      .insert({ session_id: id, case_id: s.case_id, speaker, round_number: round, ai_summary: result.summary })
      .select('id')
      .single()

    return row?.id ?? null
  }

  try {
    await Promise.all([
      ensureSummary('person_a', aExisting, personAMessages),
      ensureSummary('person_b', bExisting, personBMessages),
    ])
  } catch (err) {
    console.error('[together/turns/end] Summary generation failed:', err)
    return NextResponse.json({ error: 'Failed to generate summaries. Please try again.' }, { status: 500 })
  }

  if (totalInputTokens > 0 || totalOutputTokens > 0) {
    void db.rpc('increment_case_token_usage', {
      p_case_id: session.case_id,
      p_input_tokens: totalInputTokens,
      p_output_tokens: totalOutputTokens,
    }).then(({ error }) => {
      if (error) console.error('[together/turns/end] Token usage error:', error)
    })
  }

  // Always start review with Person A
  await db.from('together_sessions').update({ stage: 'person_a_summary_review' }).eq('id', id)

  await db.from('audit_events').insert({
    case_id: session.case_id,
    event_type: 'together_sharing_ended',
    metadata: { round },
  })

  return NextResponse.json({ nextStage: 'person_a_summary_review' })
}
