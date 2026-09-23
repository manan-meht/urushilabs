import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { requireRoomSessionAccess, isAccessError } from '@/lib/room/getSession'
import { RoomInterveneSchema } from '@/lib/validation/schemas'
import { decideIntervention, type RoomTranscriptEntry } from '@/lib/ai/room/mediationController'
import { detectDirectAddress } from '@/lib/ai/room/directAddress'
import { detectMediatorChallenge, detectVerdictRequest } from '@/lib/ai/room/mediatorChallenge'
import { decideIssueOutcome } from '@/lib/ai/room/issueMatching'
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

  const { content, trigger, silenceSeconds, speakerParticipantId, diarizationSpeakerLabel, speakerConfidence } = parsed.data
  const isPause = trigger === 'pause'

  const db = getServiceClient()

  const [{ data: participants }, { data: recentSegments }, { data: lastIntervention }, { data: recentSpokenActions }, { data: currentIssue }] = await Promise.all([
    db.from('room_participants').select('*').eq('session_id', id).order('participant_index'),
    db.from('room_transcript_segments').select('*').eq('session_id', id).order('sequence_number', { ascending: false }).limit(RECENT_TRANSCRIPT_WINDOW),
    // Only interventions Urushi actually SPOKE. Every decision is logged here,
    // including LISTEN, so taking the latest row measured time since the last
    // utterance was processed rather than since Urushi last said something —
    // and in a conversation where people talk every few seconds that is always
    // inside the cooldown. The effect was that every action except the two
    // bypass ones (DEESCALATE, END_SESSION) was permanently downgraded to
    // LISTEN, which read as a mediator that had simply decided not to speak.
    db.from('room_interventions').select('triggered_at').eq('session_id', id).not('spoken_text', 'is', null).order('triggered_at', { ascending: false }).limit(1).maybeSingle(),
    // What Urushi has actually SAID recently. Telling the model to read its own
    // turns out of the transcript did not stop it asking the same question
    // repeatedly; handing it the list does not depend on that inference.
    db.from('room_interventions').select('action, spoken_text').eq('session_id', id).not('spoken_text', 'is', null).order('triggered_at', { ascending: false }).limit(8),
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

  // A pause is not an utterance. Recording one would put empty turns in the
  // transcript that the report and the controller would both have to reason
  // around.
  const { data: utteranceSegment, error: segmentError } = isPause
    ? { data: { id: null }, error: null }
    : await db
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
  let profanityJustDisabled = false
  if (conversationSettings.allowProfanity && detectProfanityObjection(content)) {
    conversationSettings = disableProfanity(conversationSettings)
    await db
      .from('cases')
      .update(conversationSettingsToRow(conversationSettings))
      .eq('id', access.caseId)
    profanityJustDisabled = true
    console.info('[room/intervene] Strong language disabled at a participant\'s request.')
  }

  // Can we attribute anything at all?
  //
  // Asked of the TRANSCRIPT, not of the calibration. This used to be
  // `participantList.some((p) => p.speaker_label)`, which asks whether
  // diarization was calibrated — a different question. Names also resolve from
  // participant_id, which the hardware client sends directly, so an uncalibrated
  // session still produced a transcript reading "Manan: ..." / "Sonam: ..."
  // while the prompt above it insisted every line was marked "Unknown speaker"
  // and that Urushi must never say who said anything.
  //
  // The model was therefore told it could not attribute a word, and in the same
  // prompt asked to rule on whose account was stronger. It hedged, and its
  // verdicts flipped between runs on identical input. The flag has to describe
  // the text the model is actually looking at.
  // Includes the latest utterance: on the first turn of a session there is no
  // prior transcript, and judging attribution on that alone would declare the
  // room unattributable at the exact moment someone is identifiably speaking.
  //
  // A bare diarization label ("Speaker A") does not count. It separates voices
  // without naming them, which is precisely the case the warning block is for.
  const knownParticipantNames = new Set(participantList.map((p) => p.name))
  const speakersIdentified = [...recentTranscript.map((t) => t.speakerName), speakerName]
    .some((name) => knownParticipantNames.has(name))

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
  // Whose turn is it. Urushi is owed the floor when it spoke last, a participant
  // has answered since, and the room has now gone quiet — which is exactly the
  // moment a person would take their turn, and exactly what Urushi previously
  // had no way of noticing.
  const lastAssistantIndex = orderedSegments.map((s) => s.role).lastIndexOf('assistant')
  const answeredSinceUrushiSpoke = lastAssistantIndex >= 0
    && orderedSegments.slice(lastAssistantIndex + 1).some((s) => s.role === 'participant')
  const floorIsUrushis = isPause && answeredSinceUrushiSpoke

  const participantTurns = orderedSegments.filter((s) => s.role === 'participant').length
  const mediationStarted = Boolean(access.session.current_issue_id) || participantTurns >= SUBSTANTIVE_TURN_COUNT

  const decision = await decideIntervention({
    // Already resolved above for the profanity-objection check, and until now
    // never passed any further — so the personality and language the room agreed
    // to shaped nothing the room actually heard.
    settings: conversationSettings,
    topic: access.session.topic,
    contextSummary: access.session.context_summary ?? undefined,
    participantNames: participantList.map((p) => p.name),
    currentIssueTitle: currentIssue?.title,
    recentTranscript,
    latestUtterance: isPause
      ? { speakerName: 'system', content: '(the room has gone quiet)' }
      : { speakerName, content },
    secondsSinceLastIntervention,
    recentSpokenActions: (recentSpokenActions ?? []).map((r) => r.action as string),
    recentSpokenTexts: (recentSpokenActions ?? []).map((r) => r.spoken_text as string).filter(Boolean).slice(0, 3),
    // A challenge to the mediator always deserves an answer, so it bypasses the
    // cooldown for the same reason being asked a direct question does.
    challengedByParticipant: detectMediatorChallenge(content),
    askedForVerdict: detectVerdictRequest(content),
    directlyAddressed: detectDirectAddress(content) || profanityJustDisabled || detectMediatorChallenge(content) || detectVerdictRequest(content),
    silenceSeconds: isPause ? (silenceSeconds ?? 0) : undefined,
    floorIsUrushis,
    profanityJustDisabled,
    mediationStarted,
    speakersIdentified,
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

  // Any spoken turn can name the issue, not only IDENTIFY_ISSUE.
  //
  // currentIssueTitle is returned on EVERY decision — the output schema asks for
  // "the issue currently being discussed, if identifiable" regardless of action
  // — but only IDENTIFY_ISSUE ever acted on it, so the rest were silently
  // dropped. Across 16 replays the correlation was exact: a session had an issue
  // row if and only if the model happened to pick IDENTIFY_ISSUE, and 7 of 16
  // finished with no issue at all despite a clearly identified dispute. One run
  // returned "Missed deadline and agreement on date" on a CLARIFY and recorded
  // nothing.
  //
  // Adding GIVE_VERDICT made this worse rather than causing it: taking a
  // position is now often the natural action at exactly the moment the issue
  // becomes nameable, so it displaced the one action that was being listened to.
  //
  // The final report is built from these rows, so a dropped issue is a
  // conversation that gets reported as having had no subject.
  if (decision.action !== 'LISTEN' && decision.currentIssueTitle) {
    const { data: existingIssues } = await db
      .from('room_issues')
      .select('id, title, status')
      .eq('session_id', id)

    const outcome = decideIssueOutcome({
      action: decision.action,
      title: decision.currentIssueTitle,
      existing: (existingIssues ?? []).map((i) => ({ id: i.id as string, title: String(i.title) })),
      currentIssueId: access.session.current_issue_id,
      mediationStarted,
    })

    if (outcome.kind === 'reuse') {
      newIssueId = outcome.id
      if (outcome.id !== access.session.current_issue_id) {
        await db.from('room_sessions').update({ current_issue_id: outcome.id }).eq('id', id)
      }
    } else if (outcome.kind === 'create') {
      const { data: issueRow } = await db
        .from('room_issues')
        .insert({
          session_id: id,
          case_id: access.caseId,
          title: decision.currentIssueTitle,
          neutral_description: decision.reasoning,
          priority: (existingIssues ?? []).length + 1,
          status: 'discussing',
        })
        .select('id')
        .single()
      if (issueRow) {
        newIssueId = issueRow.id
        await db.from('room_sessions').update({ current_issue_id: issueRow.id }).eq('id', id)
      }
    }
  }

  if (decision.action === 'MOVE_TO_NEXT_ISSUE' && access.session.current_issue_id) {
    // 'unresolved', not 'agreed'. Moving on is not agreement, and recording one
    // as the other puts a settlement in the final report that nobody made — the
    // exact thing the mediator prompt forbids ("never record agreement that was
    // not explicitly given"). Agreement is recorded by CONFIRM_AGREEMENT, where
    // someone actually says yes.
    await db.from('room_issues').update({ status: 'unresolved' }).eq('id', access.session.current_issue_id)
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
