import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { getEnv } from '@/lib/env'
import { requireRoomSessionAccess, isAccessError } from '@/lib/room/getSession'
import { buildRealtimeSessionConfig, getRealtimeConfig } from '@/lib/ai/realtime/config'
import { buildRoomSystemInstructions } from '@/lib/ai/room/roomPrompt'
import { trackRoomEvent, ROOM_ANALYTICS_EVENTS } from '@/lib/analytics/roomEvents'
import type { DbRoomParticipant } from '@/lib/db/types'

/**
 * Mints a short-lived OpenAI Realtime client secret for the browser to connect
 * directly to OpenAI over WebRTC. The permanent OPENAI_API_KEY never leaves this
 * server. Uses raw fetch (not the `openai` SDK) — the SDK's Node HTTP internals are
 * known to hang on this app's Cloudflare Workers runtime (see src/lib/ai/voice.ts).
 *
 * Request/response shape follows OpenAI's documented ephemeral client-secret flow
 * (POST /v1/realtime/client_secrets) as of writing — re-verify against current docs
 * and this account's model access before relying on it in production.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const access = await requireRoomSessionAccess(req, id)
  if (isAccessError(access)) return NextResponse.json({ error: access.error }, { status: access.status })

  if (access.session.stage !== 'ready' && access.session.stage !== 'live' && access.session.stage !== 'paused') {
    return NextResponse.json({ error: 'Session is not ready to start.' }, { status: 409 })
  }

  const db = getServiceClient()
  const { DEMO_MODE, OPENAI_API_KEY } = getEnv()

  const { data: participants } = await db
    .from('room_participants')
    .select('*')
    .eq('session_id', id)
    .order('participant_index')

  const participantNames = ((participants ?? []) as DbRoomParticipant[]).map((p) => p.name)

  const now = new Date().toISOString()
  await db
    .from('room_sessions')
    .update({
      stage: 'live',
      realtime_session_active: true,
      started_at: access.session.started_at ?? now,
      paused_at: null,
    })
    .eq('id', id)

  await trackRoomEvent(db, { caseId: access.caseId, event: ROOM_ANALYTICS_EVENTS.STARTED })

  const { model, voice, transcribeModel } = getRealtimeConfig()

  if (DEMO_MODE || !OPENAI_API_KEY) {
    // No real key configured / demo mode — let the client simulate the room UI
    // without an actual WebRTC connection to OpenAI.
    return NextResponse.json({ demo: true, model, voice, transcribeModel })
  }

  const instructions = buildRoomSystemInstructions({
    topic: access.session.topic,
    contextSummary: access.session.context_summary ?? undefined,
    participantNames,
  })

  const sessionConfig = buildRealtimeSessionConfig({ instructions })

  const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...sessionConfig, expires_after: { anchor: 'created_at', seconds: 1800 } }),
  })

  if (!res.ok) {
    const text = await res.text()
    console.error('[room/realtime-token] OpenAI error:', res.status, text)
    await trackRoomEvent(db, { caseId: access.caseId, event: ROOM_ANALYTICS_EVENTS.CONNECTION_ERROR, metadata: { status: res.status } })
    return NextResponse.json({ error: 'Failed to start the live mediation connection.' }, { status: 502 })
  }

  const data = await res.json() as { value?: string; expires_at?: number }
  if (!data.value) {
    return NextResponse.json({ error: 'No client secret returned.' }, { status: 502 })
  }

  return NextResponse.json({
    demo: false,
    clientSecret: data.value,
    expiresAt: data.expires_at,
    model,
    voice,
    // Lets a client know upfront whether speaker identification is even possible
    // this session, instead of discovering it by waiting out a calibration
    // timeout per participant (see hardware/pi-client's calibration skip).
    transcribeModel,
  })
}
