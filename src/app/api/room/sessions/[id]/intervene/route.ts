import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireRoomSessionAccess, isAccessError } from '@/lib/room/getSession'
import { RoomInterveneSchema } from '@/lib/validation/schemas'
import { decideIntervention, type RoomTranscriptEntry } from '@/lib/ai/room/mediationController'
import { detectDirectAddress } from '@/lib/ai/room/directAddress'
import { getRealtimeConfig } from '@/lib/ai/realtime/config'
import { getConversationSettings } from '@/lib/conversation/getSettings'
import { detectProfanityObjection } from '@/lib/conversation/profanityObjection'
import { disableProfanity } from '@/lib/conversation/acceptance'
import { conversationSettingsToRow } from '@/lib/conversation/settings'
import { trackRoomEvent, ROOM_ANALYTICS_EVENTS } from '@/lib/analytics/roomEvents'
import type { DbRoomParticipant, DbRoomTranscriptSegment } from '@/lib/db/types'

const RECENT_TRANSCRIPT_WINDOW = 20

/**
 * Turns of conversation after which the group is assumed to be genuinely into the
 * dispute, so Urushi drops out of its conversational opening posture and back to
 * listening by default. Deliberately low — the opening phase is about getting
 * people talking, and overstaying it would make Urushi the chatty participant the
 * whole design exists to avoid.
 */
const SUBSTANTIVE_TURN_COUNT = 6

/**
 * Core mediation loop, called once per meaningful completed utterance the client
 * detects. Persists the utterance, asks the mediation controller whether Urushi
 * should speak, persists the decision, and applies any resulting issue/agreement
 * state changes. LISTEN is the expected common-case response.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const access = await requireRoomSessionAccess(req, id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  if (access.session.stage !== 'live') {
    return NextResponse.json({ error: 'Session is not live.' }, { status: 409 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const parsed = RoomInterveneSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  const { content, speakerParticipantId, diarizationSpeakerLabel, speakerConfidence } = parsed.data

  const db = getServiceClient()

  const [{ data: participants }, { data: recentSegments }, { data: lastIntervention }, { data: currentIssue }] = await Promise.all([
    db.from('room_participants').select('*').eq('session_id', id).order('participant_index'),
    db.from('room_transcript_segments').select('*').eq('session_id', id).order('sequence_number', { ascending: false }).limit(RECENT_TRANSCRIPT_WINDOW),
    db.from('room_interventions').select('triggered_at').eq('session_id', id).order('triggered_at', { ascending: false }).limit(1).maybeSingle(),
    access.session.current_issue_id
      ? db.from('room_issues').select('title').eq('id', access.session.current_issue_id).single()
      : Promise.resolve({ data: null }),
  ])

  const participantList = (participants ?? []) as DbRoomParticipant[]
  const nameByParticipantId = new Map(participantList.map((p) => [p.id, p.name]))
  const nameByLabel = new Map(participantList.filter((p) => p.speaker_label).map((p) => [p.speaker_label as string, p.name]))

  function resolveSpeakerName(participantId: string | null, label: string | null): string {
    if (participantId && nameByParticipantId.has(participantId)) return nameByParticipantId.get(participantId)!
    if (label && nameByLabel.has(label)) return nameByLabel.get(label)!
    return label ? `Speaker ${label}` : 'Unknown speaker'
  }

  const orderedSegments = ((recentSegments ?? []) as DbRoomTranscriptSegment[]).slice().reverse()
  const nextSequenceNumber = (orderedSegments.at(-1)?.sequence_number ?? 0) + 1

  const speakerName = resolveSpeakerName(speakerParticipantId ?? null, diarizationSpeakerLabel ?? null)

  const { data: utteranceSegment, error: segmentError } = await db
    .from('room_transcript_segments')
    .insert({
      session_id: id,
      case_id: access.caseId,
      participant_id: speakerParticipantId ?? null,
      diarization_speaker_label: diarizationSpeakerLabel ?? null,
      speaker_confidence: speakerConfidence ?? null,
      role: 'participant',
      content,
      sequence_number: nextSequenceNumber,
    })
    .select('id')
    .single()

  if (segmentError || !utteranceSegment) {
    console.error('[room/intervene] Failed to save transcript segment:', segmentError?.message)
    return NextResponse.json({ error: 'Failed to save transcript segment.' }, { status: 500 })
  }

  const recentTranscript: RoomTranscriptEntry[] = orderedSegments.map((s) => ({
    speakerName: s.role === 'assistant' ? 'Urushi' : resolveSpeakerName(s.participant_id, s.diarization_speaker_label),
    content: s.content,
  }))

  const secondsSinceLastIntervention = lastIntervention?.triggered_at
    ? (Date.now() - new Date(lastIntervention.triggered_at).getTime()) / 1000
    : Number.MAX_SAFE_INTEGER

  // Withdrawing consent to swearing takes effect NOW, before this utterance is
  // even judged — not on the next turn, and not subject to anyone else agreeing.
  // Someone asking the mediator to stop and being sworn at once more is a trust
  // failure there is no recovering from, so this does not wait on the model
  // choosing to comply with a prompt.
  let { effective: conversationSettings } = await getConversationSettings(access.caseId)
  if (conversationSettings.allowProfanity && detectProfanityObjection(content)) {
    conversationSettings = disableProfanity(conversationSettings)
    await db
      .from('cases')
      .update(conversationSettingsToRow(conversationSettings))
      .eq('id', access.caseId)
    console.info('[room/intervene] Strong language disabled at a participant\'s request.')
  }

  // Can we attribute anything at all? Without a calibrated speaker label, every
  // turn resolves to "Unknown speaker" and the prompt must be told so — see
  // MediationContext.speakersIdentified.
  const speakersIdentified = participantList.some((p) => p.speaker_label)

  // Mediation counts as started once an issue is being tracked, or once the
  // PARTICIPANTS have said enough that the group is plainly into the substance.
  // Before that, Urushi is conversationally present rather than listen-only.
  //
  // Counting participant turns only, not all segments: Urushi's own replies are
  // stored as segments too, so counting everything meant its opening plus two
  // answers was most of the budget. The room would get roughly three exchanges
  // to describe the problem before the mediator went quiet on them — which is
  // precisely backwards, since that early stretch is when people are still
  // working out what they are even arguing about.
  const participantTurns = orderedSegments.filter((s) => s.role === 'participant').length
  const mediationStarted = Boolean(access.session.current_issue_id) || participantTurns >= SUBSTANTIVE_TURN_COUNT

  const decision = await decideIntervention({
    topic: access.session.topic,
    contextSummary: access.session.context_summary ?? undefined,
    participantNames: participantList.map((p) => p.name),
    currentIssueTitle: currentIssue?.title,
    recentTranscript,
    latestUtterance: { speakerName, content },
    secondsSinceLastIntervention,
    directlyAddressed: detectDirectAddress(content),
    mediationStarted,
    speakersIdentified,
    // Urushi speaks the room's language, in the room's register — see spokenLanguage.ts.
    spokenLanguages: getRealtimeConfig().transcribeLanguages,
  })

  const { data: interventionRow, error: interventionError } = await db
    .from('room_interventions')
    .insert({
      session_id: id,
      case_id: access.caseId,
      action: decision.action,
      reasoning: decision.reasoning,
      spoken_text: decision.spokenText ?? null,
    })
    .select('id')
    .single()

  if (interventionError) {
    console.error('[room/intervene] Failed to log intervention:', interventionError.message)
  }

  let newIssueId: string | null = null
  let newAgreementId: string | null = null

  if (decision.action === 'IDENTIFY_ISSUE' && decision.currentIssueTitle) {
    const { count } = await db.from('room_issues').select('id', { count: 'exact', head: true }).eq('session_id', id)
    const { data: issueRow } = await db
      .from('room_issues')
      .insert({
        session_id: id,
        case_id: access.caseId,
        title: decision.currentIssueTitle,
        neutral_description: decision.reasoning,
        priority: (count ?? 0) + 1,
        status: 'discussing',
      })
      .select('id')
      .single()
    if (issueRow) {
      newIssueId = issueRow.id
      await db.from('room_sessions').update({ current_issue_id: issueRow.id }).eq('id', id)
    }
  }

  if (decision.action === 'MOVE_TO_NEXT_ISSUE' && access.session.current_issue_id) {
    await db.from('room_issues').update({ status: 'agreed' }).eq('id', access.session.current_issue_id)
    await db.from('room_sessions').update({ current_issue_id: null }).eq('id', id)
  }

  if (decision.action === 'PROPOSE_COMPROMISE' && decision.emergingAgreement) {
    const { data: agreementRow } = await db
      .from('room_agreements')
      .insert({
        session_id: id,
        case_id: access.caseId,
        issue_id: access.session.current_issue_id,
        description: decision.emergingAgreement,
        agreed_by: [],
        awaiting: participantList.map((p) => p.id),
      })
      .select('id')
      .single()
    if (agreementRow) newAgreementId = agreementRow.id
  }

  if (decision.action === 'SUMMARIZE' && decision.spokenText) {
    await db.from('room_sessions').update({ conversation_summary: decision.spokenText }).eq('id', id)
  }

  if (decision.action !== 'LISTEN') {
    if (decision.spokenText) {
      await db.from('room_transcript_segments').insert({
        session_id: id,
        case_id: access.caseId,
        role: 'assistant',
        content: decision.spokenText,
        sequence_number: nextSequenceNumber + 1,
      })
    }
    await trackRoomEvent(db, {
      caseId: access.caseId,
      event: ROOM_ANALYTICS_EVENTS.INTERVENTION,
      metadata: { action: decision.action },
    })
  }

  return NextResponse.json({
    decision,
    transcriptSegmentId: utteranceSegment.id,
    interventionId: interventionRow?.id ?? null,
    issueId: newIssueId,
    agreementId: newAgreementId,
  })
}
