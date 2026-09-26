/**
 * Server-only: the explicit mediation intervention controller for Meeting Mediation.
 * Same decision discipline as src/lib/ai/room/mediationController.ts (Live
 * Mediation) — LISTEN is the default and most common outcome — kept as an
 * independent copy so Live Mediation's file is never touched by this work. Both
 * transports feed into the same style of decision process; a future shared
 * "mediation core" package could de-duplicate these once both are stable.
 *
 * This module knows nothing about Recall, Google Meet, or Zoom — it only sees
 * normalized transcript entries (see src/lib/meeting/provider.ts). That boundary
 * is what lets Urushi later swap the meeting transport without touching this file.
 */

import { z } from 'zod'
import { getEnv } from '@/lib/env'
import { detectEscalationSignal, enforceCooldown, isTrivialUtterance } from './interventionGuardrails'
import { buildMeetingInterventionPrompt } from './interventionPrompt'
import { completionParams } from '@/lib/ai/modelParams'

export const MeetingInterventionActionSchema = z.enum([
  'LISTEN',
  'CLARIFY',
  'INVITE_PARTICIPANT',
  'REFRAME',
  'DEESCALATE',
  'IDENTIFY_ISSUE',
  'SUMMARIZE',
  'PROPOSE_COMPROMISE',
  'CONFIRM_AGREEMENT',
  'MOVE_TO_NEXT_ISSUE',
  'END_SESSION',
])

export const MeetingInterventionDecisionSchema = z.object({
  action: MeetingInterventionActionSchema,
  reasoning: z.string().min(1),
  spokenText: z.string().optional(),
  currentIssueTitle: z.string().optional(),
  emergingAgreement: z.string().optional(),
})

export type MeetingInterventionDecision = z.infer<typeof MeetingInterventionDecisionSchema>

export interface MeetingTranscriptEntry {
  speakerName: string
  content: string
}

export interface ParticipantPerspective {
  participantName: string
  /** Decrypted plaintext — caller is responsible for decryption; never logged. */
  perspective: string
}

export interface MeetingMediationContext {
  topic: string
  contextSummary?: string
  participantNames: string[]
  /** Private pre-meeting perspectives — treated as hypotheses, never disclosed verbatim (spec §6). */
  participantPerspectives?: ParticipantPerspective[]
  currentIssueTitle?: string
  /** Oldest first, excluding the latest utterance. */
  recentTranscript: MeetingTranscriptEntry[]
  latestUtterance: MeetingTranscriptEntry
  secondsSinceLastIntervention: number
}

export async function decideMeetingIntervention(ctx: MeetingMediationContext): Promise<MeetingInterventionDecision> {
  if (isTrivialUtterance(ctx.latestUtterance.content) && !detectEscalationSignal(ctx.latestUtterance.content)) {
    return { action: 'LISTEN', reasoning: 'Trivial acknowledgement — no mediation value in interrupting.' }
  }

  const { DEMO_MODE, OPENAI_API_KEY, OPENAI_MODEL } = getEnv()

  if (DEMO_MODE) {
    return { action: 'LISTEN', reasoning: 'Demo mode — Urushi listens by default; no live model call is made.' }
  }

  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.')

  const { system, user } = buildMeetingInterventionPrompt(ctx)

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      ...completionParams(OPENAI_MODEL, 400, 0.2),
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OpenAI meeting mediation controller failed (${res.status}): ${text}`)
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  const raw = data.choices?.[0]?.message?.content
  if (!raw) throw new Error('Empty response from OpenAI.')

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error('OpenAI returned invalid JSON for meeting intervention decision.')
  }

  const parsed = MeetingInterventionDecisionSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(`Meeting intervention decision schema validation failed: ${parsed.error.message}`)
  }

  const finalAction = enforceCooldown({
    proposedAction: parsed.data.action,
    secondsSinceLastIntervention: ctx.secondsSinceLastIntervention,
  })

  if (finalAction !== parsed.data.action) {
    return { action: finalAction, reasoning: 'Cooldown — Urushi intervened recently; continuing to listen.' }
  }

  return parsed.data
}
