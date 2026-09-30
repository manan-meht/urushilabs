import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { getMeetingBotProvider } from '@/lib/meeting/providerFactory'
import { ingestMeetingTranscriptSegment, speakInMeeting, recordAssistantSegment, MEETING_INTRODUCTION } from '@/lib/meeting/pipeline'
import { mergeRuntimeState, speakingPatch } from '@/lib/meeting/runtimeStateStore'
import { statusTileUrl } from '@/lib/meeting/statusTile'
import { completeMeetingSession } from '@/lib/meeting/completeSession'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { trackMeetingEvent, MEETING_ANALYTICS_EVENTS } from '@/lib/analytics/meetingEvents'
import type { NormalizedProviderEvent } from '@/lib/meeting/provider'
import type { DbMeetingSession } from '@/lib/db/types'

/**
 * Recall.ai webhook receiver. Handles BOTH the account-level webhook (bot status
 * changes — configured in the Recall dashboard) and the per-bot realtime webhook
 * (transcript/participant events — configured on bot creation, see
 * src/lib/meeting/providers/recallProvider.ts createBot()); both are pointed at
 * this same URL for simplicity. See docs/meeting-mediation-recall-setup.md for
 * what to register in the Recall dashboard.
 *
 * Urushi never trusts a webhook body until verifyWebhook() passes — this is the
 * only place that boundary is enforced. Idempotency (spec §35) is enforced via
 * meeting_provider_events' unique (bot_provider, provider_event_id) constraint:
 * a retried delivery is a harmless duplicate-insert no-op, never reprocessed.
 */
/**
 * Runs work after the 200 has gone back to Recall.
 *
 * The transcript handler used to be awaited inline — Stage A, Stage B, a
 * twelve-second floor wait, TTS and delivery, all before Recall got its
 * response. Recall retries on non-2xx only, and everything it had queued sat
 * behind us. Cloudflare's waitUntil keeps the Worker alive for the promise;
 * locally there is no such context and we simply await.
 */
function runInBackground(label: string, work: Promise<unknown>): Promise<void> {
  const guarded = work.catch((err) => console.error(`[recall webhook] ${label} failed:`, err))
  try {
    getCloudflareContext().ctx.waitUntil(guarded)
    return Promise.resolve()
  } catch {
    return guarded.then(() => undefined)
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const provider = getMeetingBotProvider()

  if (!provider.isConfigured()) {
    // No Recall credentials configured in this environment — nothing to verify
    // against, and no session could plausibly be waiting on this bot. Accept and
    // no-op rather than 5xx (Recall would otherwise retry a webhook we can never
    // process in this environment).
    return NextResponse.json({ ok: true, note: 'Recall not configured — event ignored.' })
  }

  const verified = provider.verifyWebhook({
    rawBody,
    headers: {
      'webhook-id': req.headers.get('webhook-id'),
      'webhook-timestamp': req.headers.get('webhook-timestamp'),
      'webhook-signature': req.headers.get('webhook-signature'),
      'svix-id': req.headers.get('svix-id'),
      'svix-timestamp': req.headers.get('svix-timestamp'),
      'svix-signature': req.headers.get('svix-signature'),
    },
  })

  if (!verified) {
    console.error('[recall webhook] signature verification failed', {
      headers: {
        'webhook-id': req.headers.get('webhook-id'),
        'webhook-timestamp': req.headers.get('webhook-timestamp'),
        'webhook-signature': req.headers.get('webhook-signature'),
        'svix-id': req.headers.get('svix-id'),
        'svix-timestamp': req.headers.get('svix-timestamp'),
        'svix-signature': req.headers.get('svix-signature'),
      },
      bodyPreview: rawBody.slice(0, 300),
    })
    return NextResponse.json({ error: 'Invalid webhook signature.' }, { status: 401 })
  }

  const events = provider.handleWebhook(rawBody)
  const db = getServiceClient()

  // Acknowledge first, process after. Recall delivers a bot's realtime events
  // one at a time and waits for each response; with streaming transcription
  // that is around two events a second, and even our fast path — four
  // database round trips — took longer than the gap between them. The backlog
  // grew by about a third of a second every second: a session's transcript was
  // 82 s behind at minute five and 128 s behind at minute seven. Nothing here
  // is worth making Recall wait for.
  await runInBackground('events', (async () => {
    for (const event of events) {
      await processEvent(db, event)
    }
  })())

  return NextResponse.json({ ok: true, accepted: events.length })
}

async function processEvent(db: ReturnType<typeof getServiceClient>, event: NormalizedProviderEvent): Promise<void> {
  // Idempotency guard — insert-or-skip on the unique (bot_provider, provider_event_id).
  const { error: insertError } = await db.from('meeting_provider_events').insert({
    bot_provider: 'recall',
    provider_event_id: event.providerEventId,
    event_type: event.type,
    payload: event.raw,
  })
  if (insertError) {
    // Unique violation means we've already processed this exact event — normal
    // and expected on webhook retries, not an error.
    return
  }

  const { data: session } = await db
    .from('meeting_sessions')
    .select('*')
    .eq('provider_bot_id', event.providerBotId)
    .single()

  if (!session) {
    await db.from('meeting_provider_events')
      .update({ error_message: 'No matching meeting_sessions row for this provider_bot_id.' })
      .eq('provider_event_id', event.providerEventId)
      .eq('bot_provider', 'recall')
    return
  }

  const meetingSession = session as DbMeetingSession

  try {
    switch (event.type) {
      case 'bot_joining':
        await db.from('meeting_sessions').update({ status: 'joining' }).eq('id', meetingSession.id)
        await trackMeetingEvent(db, { caseId: meetingSession.case_id, event: MEETING_ANALYTICS_EVENTS.BOT_JOINING })
        break

      case 'bot_waiting_room':
        await db.from('meeting_sessions').update({ status: 'waiting_room' }).eq('id', meetingSession.id)
        await trackMeetingEvent(db, { caseId: meetingSession.case_id, event: MEETING_ANALYTICS_EVENTS.BOT_WAITING_ROOM })
        break

      case 'bot_admitted': {
        // Recall can report several distinct status codes (in_call_recording,
        // in_call_not_recording, recording_permission_allowed, ...) that all map to
        // bot_admitted, sometimes within the same second — concurrent webhook
        // requests would otherwise all read status 'joining' before any of them
        // commit, defeating a read-then-write guard. The conditional UPDATE below
        // is atomic at the DB level: only the request that actually flips the row
        // gets rows back, so only one ever triggers the introduction.
        const { data: transitioned } = await db.from('meeting_sessions')
          .update({
            status: 'in_meeting',
            joined_at: meetingSession.joined_at ?? new Date().toISOString(),
          })
          .eq('id', meetingSession.id)
          .neq('status', 'in_meeting')
          .select('id')

        if (transitioned && transitioned.length > 0) {
          await trackMeetingEvent(db, { caseId: meetingSession.case_id, event: MEETING_ANALYTICS_EVENTS.BOT_JOINED })
          await trackMeetingEvent(db, { caseId: meetingSession.case_id, event: MEETING_ANALYTICS_EVENTS.STARTED })
          // Recorded BEFORE it is spoken, so that when Recall transcribes
          // Urushi's own audio back, isEchoOfUrushi has something to match. Left
          // unrecorded, the introduction was ingested as a participant called
          // "Unknown" in a live session and fed to the engine as testimony.
          await recordAssistantSegment(db, meetingSession, MEETING_INTRODUCTION)

          // Put the status screen in the camera tile before the first word.
          // Best-effort: if output_media is unavailable the meeting still runs,
          // it just runs without a visible "about to speak" cue.
          if (meetingSession.provider_bot_id) {
            try {
              await getMeetingBotProvider().startOutputMedia({
                providerBotId: meetingSession.provider_bot_id,
                url: statusTileUrl(meetingSession.id),
              })
            } catch (err) {
              console.warn('[recall webhook] could not start status tile:', err instanceof Error ? err.message : err)
            }
          }

          await runInBackground('introduction', speakInMeeting(meetingSession, MEETING_INTRODUCTION))
        }
        break
      }

      case 'participant_joined':
        if (event.participant) {
          // Best-effort name-based mapping to an Urushi participant — never silently
          // overwrite an existing confident mapping, and never guess when names collide.
          const { data: candidates } = await db
            .from('meeting_participants')
            .select('id, name, provider_participant_id')
            .eq('session_id', meetingSession.id)

          const unmapped = (candidates ?? []).filter((c) => !c.provider_participant_id)
          const match = unmapped.find(
            (c) => c.name.trim().toLowerCase() === (event.participant!.displayName ?? '').trim().toLowerCase()
          )
          if (match && unmapped.filter((c) => c.name.trim().toLowerCase() === match.name.trim().toLowerCase()).length === 1) {
            await db.from('meeting_participants')
              .update({ provider_participant_id: event.participant.providerParticipantId })
              .eq('id', match.id)
          }
        }
        break

      case 'participant_left':
        await trackMeetingEvent(db, { caseId: meetingSession.case_id, event: MEETING_ANALYTICS_EVENTS.BOT_DISCONNECTED, metadata: { participant: true } })
        break

      case 'participant_speaking': {
        // Keeps runtime_state.speakingNow current so speakInMeeting can wait
        // for a clear floor. A merge of this one participant's entry, so it
        // survives the pipeline persisting its own keys mid-flight — the
        // whole-object write it replaced lost every one of these.
        if (event.participant) {
          const at = Date.parse(event.occurredAt) || Date.now()
          const speaking = event.speaking === true
          // A partial transcript arrives as speaking:true; it also marks the
          // moment, so a gap in speech_on/off coverage still reads as occupied.
          const partial = speaking && (event.raw as { event?: string })?.event === 'transcript.partial_data'
          await mergeRuntimeState(db, meetingSession.id, speakingPatch(event.participant.providerParticipantId, speaking, at, partial))
        }
        break
      }

      case 'transcript_segment':
        if (event.transcriptSegment) {
          await runInBackground('transcript ingest', ingestMeetingTranscriptSegment({
            sessionId: meetingSession.id,
            providerParticipantId: event.transcriptSegment.providerParticipantId,
            speakerName: event.transcriptSegment.speakerName,
            content: event.transcriptSegment.text,
            startedAt: event.transcriptSegment.startedAt,
            endedAt: event.transcriptSegment.endedAt,
            confidence: event.transcriptSegment.confidence,
          }))
        }
        break

      case 'meeting_ended': {
        await db.from('meeting_sessions').update({
          status: 'ended',
          ended_at: new Date().toISOString(),
        }).eq('id', meetingSession.id)
        await trackMeetingEvent(db, { caseId: meetingSession.case_id, event: MEETING_ANALYTICS_EVENTS.COMPLETED, metadata: { trigger: 'provider' } })

        // Fire-and-forget — report generation is idempotent and can also be
        // retried manually from the status page if this fails. Registered with
        // Cloudflare's ctx.waitUntil so the Worker stays alive long enough to
        // finish: without this, the runtime can terminate the execution context
        // as soon as this webhook's HTTP response is sent, killing the promise
        // mid-flight and leaving final_report permanently null (same pattern as
        // src/app/api/intake/complete/route.ts).
        await runInBackground('completeMeetingSession', completeMeetingSession(meetingSession.id))
        break
      }

      case 'bot_removed':
        // 'generating_report' is an in-progress state, not a terminal one — this
        // event can legitimately race with an already-running completeMeetingSession
        // (Recall reports the bot fully removed shortly after meeting_ended, often
        // while the report is still being generated). Treating it as a fresh
        // disconnect here would clobber status out from under the report and leave
        // the session stuck looking disconnected even after final_report is set.
        if (!['completed', 'ended', 'generating_report'].includes(meetingSession.status)) {
          await db.from('meeting_sessions').update({ status: 'disconnected' }).eq('id', meetingSession.id)
          await trackMeetingEvent(db, { caseId: meetingSession.case_id, event: MEETING_ANALYTICS_EVENTS.BOT_DISCONNECTED })
        }
        break

      case 'bot_error':
        await db.from('meeting_sessions').update({
          status: 'failed',
          failure_reason: event.errorMessage ?? 'The meeting bot reported an error.',
        }).eq('id', meetingSession.id)
        await trackMeetingEvent(db, { caseId: meetingSession.case_id, event: MEETING_ANALYTICS_EVENTS.FAILED, metadata: { stage: 'in_meeting' } })
        break

      default:
        break
    }

    await db.from('meeting_provider_events')
      .update({ processed_at: new Date().toISOString(), session_id: meetingSession.id })
      .eq('provider_event_id', event.providerEventId)
      .eq('bot_provider', 'recall')
  } catch (err) {
    console.error('[recall webhook] event processing failed:', event.type, err)
    await db.from('meeting_provider_events')
      .update({ error_message: err instanceof Error ? err.message : 'Unknown error', session_id: meetingSession.id })
      .eq('provider_event_id', event.providerEventId)
      .eq('bot_provider', 'recall')
  }
}
