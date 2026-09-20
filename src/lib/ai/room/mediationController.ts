/**
 * Server-only: the explicit mediation intervention controller. Decides, for each
 * meaningful completed utterance, whether Urushi should speak — LISTEN is the
 * default and most common outcome. This is deliberately a separate decision
 * process from the Realtime voice model's own turn detection (which never
 * auto-replies — see src/lib/ai/realtime/config.ts). Never import from client
 * components.
 */

import { z } from 'zod'
import { getEnv } from '@/lib/env'
import { detectEscalationSignal, enforceCooldown, isTrivialUtterance } from './interventionGuardrails'
import { buildInterventionPrompt } from './interventionPrompt'

export const InterventionActionSchema = z.enum([
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

export const InterventionDecisionSchema = z.object({
  action: InterventionActionSchema,
  reasoning: z.string().min(1),
  spokenText: z.string().optional(),
  currentIssueTitle: z.string().optional(),
  emergingAgreement: z.string().optional(),
})

export type InterventionDecision = z.infer<typeof InterventionDecisionSchema>

export interface RoomTranscriptEntry {
  speakerName: string
  content: string
}

export interface MediationContext {
  topic: string
  contextSummary?: string
  participantNames: string[]
  currentIssueTitle?: string
  /** Most recent entries first-to-last (oldest first), excluding the latest utterance. */
  recentTranscript: RoomTranscriptEntry[]
  latestUtterance: RoomTranscriptEntry
  secondsSinceLastIntervention: number
  /**
   * A participant explicitly asked Urushi to speak (see directAddress.ts).
   * Overrides the listen-by-default posture and the cooldown — someone asking a
   * direct question and getting silence reads as broken, not as discretion.
   */
  directlyAddressed?: boolean
  /**
   * False until the group is actually discussing the dispute. Before that,
   * Urushi is conversationally present: it opens, answers, and steers people
   * toward starting — rather than silently waiting for a conflict to appear.
   */
  mediationStarted?: boolean
  /**
   * Whether utterances can be attributed to named participants at all.
   *
   * False whenever speaker labels are unavailable — which is the normal case on
   * an organisation without access to a diarization-capable transcription model.
   * The room then arrives as one undifferentiated voice, and every turn reads as
   * "Unknown speaker".
   *
   * This must reach the prompt. Left unsaid, the model fills the gap with the
   * plausible assumption that everyone present has been talking: observed live,
   * Urushi told a participant "after hearing both your views" when only one
   * person had ever spoken. A mediator that misreports who said what loses the
   * room's trust faster than one that admits it cannot tell.
   */
  speakersIdentified?: boolean
  /**
   * ISO-639-1 codes for the languages spoken in the room, from the session's
   * transcription config. Decides the register Urushi speaks in — see
   * spokenLanguage.ts. Empty or English-only means no special direction.
   */
  spokenLanguages?: string[]
  /**
   * Someone just asked Urushi to stop swearing and it has been turned off for
   * the session.
   *
   * Disabling silently would leave the person who asked with no idea whether
   * they were heard, and no way to find out until Urushi next happens to speak.
   * A brief acknowledgement closes that loop — and it must be brief, because
   * dwelling on it makes an awkward moment bigger than it was.
   */
  profanityJustDisabled?: boolean
  /**
   * How long the room has been quiet, when this decision was triggered by a
   * PAUSE rather than by someone finishing a sentence. Undefined otherwise.
   */
  silenceSeconds?: number
  /**
   * Urushi spoke last, someone answered, and the room has now gone quiet — so
   * the floor is Urushi's by ordinary conversational turn-taking.
   *
   * People do this without thinking: you answer someone's question, you stop,
   * and you expect them to speak. Urushi had no model of it, so a participant
   * would finish, wait, and get nothing — which reads as the device being dead
   * rather than as a mediator choosing to stay quiet.
   */
  floorIsUrushis?: boolean
  /**
   * Actions Urushi has actually SPOKEN recently, most recent first.
   *
   * Telling the model to read its own turns out of the transcript did not stop
   * it asking the same thing repeatedly — observed live asking a room to confirm
   * the same two issues after they had confirmed them several times, which is
   * how a mediator stops being taken seriously. Handing it the list removes the
   * inference.
   */
  recentSpokenActions?: string[]
}

export async function decideIntervention(ctx: MediationContext): Promise<InterventionDecision> {
  // Being asked a direct question and getting silence reads as broken, so a
  // direct address skips both shortcuts below: a short "Urushi?" would otherwise
  // be dismissed as trivial, and the cooldown would swallow follow-up questions.
  const directlyAddressed = ctx.directlyAddressed === true

  // Fast path: trivial acknowledgements never warrant intervention, and never need
  // an LLM call to figure that out — unless they carry an escalation signal (e.g.
  // a hostile one-word reply is still worth flagging via detectEscalationSignal).
  if (
    !directlyAddressed &&
    isTrivialUtterance(ctx.latestUtterance.content) &&
    !detectEscalationSignal(ctx.latestUtterance.content)
  ) {
    return { action: 'LISTEN', reasoning: 'Trivial acknowledgement — no mediation value in interrupting.' }
  }

  const { DEMO_MODE, OPENAI_API_KEY, OPENAI_MODEL } = getEnv()

  if (DEMO_MODE) {
    return { action: 'LISTEN', reasoning: 'Demo mode — Urushi listens by default; no live model call is made.' }
  }

  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.')

  const { system, user } = buildInterventionPrompt(ctx)

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      max_tokens: 400,
      temperature: 0.2,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OpenAI mediation controller failed (${res.status}): ${text}`)
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  const raw = data.choices?.[0]?.message?.content
  if (!raw) throw new Error('Empty response from OpenAI.')

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error('OpenAI returned invalid JSON for intervention decision.')
  }

  const parsed = InterventionDecisionSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(`Intervention decision schema validation failed: ${parsed.error.message}`)
  }

  // A person who asked a direct question gets an answer regardless of how
  // recently Urushi last spoke.
  if (directlyAddressed) return parsed.data

  const finalAction = enforceCooldown({
    proposedAction: parsed.data.action,
    secondsSinceLastIntervention: ctx.secondsSinceLastIntervention,
  })

  if (finalAction !== parsed.data.action) {
    return { action: finalAction, reasoning: 'Cooldown — Urushi intervened recently; continuing to listen.' }
  }

  return parsed.data
}
