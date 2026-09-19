import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { TogetherMessageSchema } from '@/lib/validation/schemas'
import { reviewMessage } from '@/lib/ai/together/reviewMessage'
import { getEffectiveSettings } from '@/lib/conversation/getSettings'
import { verifyTogetherAccess } from '@/lib/together/verifyAccess'

const SHARING_STAGES = new Set([
  'person_a_sharing', 'person_b_sharing',
])

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const access = await verifyTogetherAccess(id)
  if (!access) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const parsed = TogetherMessageSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  const { content, speaker, replyToId, useReframe } = parsed.data

  // Ensure the caller is submitting as their own identity
  if (speaker !== access.speaker) {
    return NextResponse.json({ error: 'You can only submit messages as yourself.' }, { status: 403 })
  }

  const db = getServiceClient()

  const { data: session } = await db
    .from('together_sessions')
    .select('id, stage, current_speaker, round_number, person_a_name, person_b_name, topic, case_id')
    .eq('id', id)
    .single()

  if (!session) return NextResponse.json({ error: 'Session not found.' }, { status: 404 })

  if (!SHARING_STAGES.has(session.stage)) {
    return NextResponse.json({ error: 'Session is not in a sharing stage.' }, { status: 409 })
  }

  if (session.current_speaker !== speaker) {
    return NextResponse.json({ error: 'It is not your turn.' }, { status: 403 })
  }

  const speakerName = speaker === 'person_a' ? session.person_a_name : session.person_b_name
  const otherName = speaker === 'person_a' ? session.person_b_name : session.person_a_name

  const settings = await getEffectiveSettings(session.case_id)

  // AI message review (non-blocking — graceful failure)
  let review = null
  try {
    review = await reviewMessage({
      speakerName,
      otherName,
      topic: session.topic,
      content,
      settings,
    })
  } catch (err) {
    console.error('[together/messages] AI review failed, continuing without:', err)
  }

  // If caller explicitly chose to use the reframe, use it as display content
  const displayContent =
    useReframe && review?.suggestedReframe
      ? review.suggestedReframe
      : (review?.classification === 'display_as_written' || !review)
        ? content
        : null  // null means client needs to choose

  // If AI flagged a safety intervention, don't store yet — return for client handling
  if (review?.classification === 'block_or_safety_intervention' && !useReframe) {
    return NextResponse.json({
      blocked: true,
      review,
    })
  }

  // If a reframe is offered and client hasn't chosen yet, return for decision
  if (review?.classification === 'offer_reframe' && displayContent === null) {
    return NextResponse.json({
      needsChoice: true,
      review,
    })
  }

  const { data: message, error: msgError } = await db
    .from('together_messages')
    .insert({
      session_id: id,
      case_id: session.case_id,
      speaker,
      content,
      display_content: displayContent ?? content,
      message_review: review,
      reply_to_id: replyToId ?? null,
      round_number: session.round_number,
    })
    .select('*')
    .single()

  if (msgError || !message) {
    console.error('[together/messages] DB error:', msgError?.message)
    return NextResponse.json({ error: 'Failed to save message.' }, { status: 500 })
  }

  // Auto-switch speaker after every message so the other person responds next
  const nextSpeaker = speaker === 'person_a' ? 'person_b' : 'person_a'
  const nextStage = nextSpeaker === 'person_a' ? 'person_a_sharing' : 'person_b_sharing'
  await db
    .from('together_sessions')
    .update({ current_speaker: nextSpeaker, stage: nextStage })
    .eq('id', id)

  return NextResponse.json({ message, nextSpeaker, nextStage })
}
