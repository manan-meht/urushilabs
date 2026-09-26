import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { getEnv } from '@/lib/env'
import { requireRoomSessionAccess, isAccessError } from '@/lib/room/getSession'
import { buildRoomSystemInstructions } from '@/lib/ai/room/roomPrompt'
import { buildOpeningInstruction, buildFallbackOpening } from '@/lib/ai/room/openingPrompt'
import { getConversationSettings } from '@/lib/conversation/getSettings'
import { SHARED_DEVICE_REF } from '@/lib/conversation/acceptance'
import type { DbRoomParticipant } from '@/lib/db/types'
import { completionParams } from '@/lib/ai/modelParams'

/**
 * Generates Urushi's opening line, spoken once when a session goes live.
 *
 * Exists because Room Mode's listen-by-default posture made sessions feel dead on
 * arrival: nobody has raised a dispute yet, so the intervention controller
 * correctly decides there's nothing to intervene in, and participants sit in
 * silence wondering whether the device works. An opening gives the room a way in.
 *
 * This route only GENERATES the line — it deliberately does not record it. The
 * client confirms via POST ./opening/delivered once the words have actually gone
 * out over a live audio channel, and only that marks the session as opened.
 *
 * Splitting it was not academic: recording at generation time meant a client that
 * fetched an opening and then lost its WebRTC connection before speaking had
 * permanently consumed it. Every reconnect after that got alreadyOpened: true, so
 * the room sat in silence and the transcript claimed Urushi had introduced itself.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const access = await requireRoomSessionAccess(req, id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  const db = getServiceClient()

  // Urushi has already said something in this session, so the room knows it's
  // there — don't introduce it a second time. Any assistant turn counts, not just
  // a recorded opening: a session where Urushi has already intervened is well
  // past the point where "hello, I'm Urushi" makes sense.
  const { count } = await db
    .from('room_transcript_segments')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', id)
    .eq('role', 'assistant')

  if ((count ?? 0) > 0) {
    return NextResponse.json({ spokenText: null, alreadyOpened: true })
  }

  const { OPENAI_API_KEY, OPENAI_MODEL, DEMO_MODE } = getEnv()

  const { data: participants } = await db
    .from('room_participants')
    .select('*')
    .eq('session_id', id)
    .order('participant_index')

  const participantNames = ((participants ?? []) as DbRoomParticipant[]).map((p) => p.name)

  // The AGREED conversation settings, not the env transcription languages. The
  // opening used to key off the latter, so it ignored the language and
  // personality the participants actually chose at setup.
  const { effective: settings, acceptance } = await getConversationSettings(access.caseId, [SHARED_DEVICE_REF])

  const openingContext = {
    settings,
    // Consent, not configuration: the strong opening is the very first thing
    // anyone hears, so it waits for actual acceptance rather than a proposal.
    profanityAccepted: acceptance.profanityPermitted,
    // Anything already known about the dispute means asking them to start from
    // scratch would waste the first minute of the session.
    hasContext: Boolean(access.session.context_summary?.trim()),
  }

  if (DEMO_MODE || !OPENAI_API_KEY) {
    return NextResponse.json({
      spokenText: buildFallbackOpening({
        ...openingContext,
        participantNames,
        topic: access.session.topic,
      }),
      alreadyOpened: false,
    })
  }

  const system = buildRoomSystemInstructions({
    topic: access.session.topic,
    contextSummary: access.session.context_summary ?? undefined,
    participantNames,
    settings,
  })

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: buildOpeningInstruction(openingContext) },
      ],
      ...completionParams(OPENAI_MODEL, 160, 0.6),
    }),
  })

  if (!res.ok) {
    console.error('[room/opening] OpenAI error:', res.status, await res.text())
    return NextResponse.json({ error: 'Failed to generate the opening.' }, { status: 502 })
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  const spokenText = data.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, '')
  if (!spokenText) {
    return NextResponse.json({ error: 'Empty opening returned.' }, { status: 502 })
  }

  return NextResponse.json({ spokenText, alreadyOpened: false })
}
