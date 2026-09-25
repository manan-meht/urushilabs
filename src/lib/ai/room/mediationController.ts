/**
 * Server-only: the explicit mediation intervention controller. Decides, for each
 * meaningful completed utterance, whether Urushi should speak — LISTEN is the
 * default and most common outcome. This is deliberately a separate decision
 * process from the Realtime voice model's own turn detection (which never
 * auto-replies — see src/lib/ai/realtime/config.ts). Never import from client
 * components.
 */

import { z } from 'zod'
import type { ConversationSettings } from '@/lib/conversation/settings'
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
  'GIVE_VERDICT',
])

/**
 * `.nullish()`, not `.optional()`, on every optional field.
 *
 * The model does not omit a field it has nothing to say for — it sends
 * `"emergingAgreement": null`. `.optional()` accepts `undefined` and rejects
 * `null`, so a perfectly reasonable response failed schema validation and threw,
 * and the mediator went silent for that turn. Intermittent by nature: it depends
 * on whether the model chooses to emit the key at all.
 */
const optionalText = z.string().nullish().transform((v) => v ?? undefined)

export const InterventionDecisionSchema = z.object({
  action: InterventionActionSchema,
  reasoning: z.string().min(1),
  spokenText: optionalText,
  currentIssueTitle: optionalText,
  emergingAgreement: optionalText,
})

export type InterventionDecision = z.infer<typeof InterventionDecisionSchema>

/**
 * What the call cost, attached to the decision.
 *
 * The API returns this on every response and it was being discarded, which is
 * why no mediation has ever had a recorded cost. Optional because the fast
 * paths — a trivial utterance, demo mode, a cooldown — never call the model at
 * all, and reporting zero tokens for those is accurate.
 */
export interface DecisionUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}

export interface DecisionResult {
  decision: InterventionDecision
  usage?: DecisionUsage
}

export interface RoomTranscriptEntry {
  speakerName: string
  content: string
}

export interface MediationContext {
  /**
   * The personality, language and profanity the participants agreed to.
   *
   * REQUIRED, with no default, because the optional version of this was the bug.
   * The persona modules were built, tested and wired into the opening and the
   * reports — and never reached the intervention controller, which produces
   * essentially everything Urushi says once mediation is underway. A room that
   * chose the Straight Shooter got the Diplomat for the entire conversation and
   * nothing failed; the setting was simply absent from the prompt.
   *
   * A required field cannot be forgotten by a future caller the way an optional
   * one silently was.
   */
  settings: ConversationSettings
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
  /**
   * The exact words of Urushi's last few spoken turns, most recent first.
   *
   * Action types alone were not enough: two DEESCALATEs 34 seconds apart said
   * nearly the same sentence and the guard, which watched only three action
   * types, saw nothing. A participant noticed before the system did — "ye aap do
   * baar bol chuke ho".
   *
   * Several turns rather than one, because the tic was a closing phrase that
   * recurred every few turns ("aap dono ke liye kya important hai") and a
   * comparison against only the previous turn never saw it.
   */
  recentSpokenTexts?: string[]
  /**
   * A participant just told Urushi it is failing them — being one-sided,
   * repeating itself, or not helping.
   *
   * Carried as a flag so the instruction can go in FINAL position, which is the
   * only place it has held. Three mid-prompt rules produced three different
   * evasions: a de-escalation, a request for more input, and a question about
   * other issues.
   */
  challengedByParticipant?: boolean
  /**
   * Someone asked Urushi to say who is right.
   *
   * The Straight Shooter's whole proposition. Carried as a flag so the
   * instruction lands in final position — the personality module already said
   * not to answer with "explain in more detail", and it did exactly that.
   */
  askedForVerdict?: boolean
}

/**
 * Per-model request parameters, because they are not interchangeable.
 *
 * The newer families reject outright what the older ones require. gpt-6-luna
 * returns 400 for `max_tokens` (it wants `max_completion_tokens`) and 400 again
 * for any `temperature` other than the default. Switching model by environment
 * variable alone would therefore have broken every intervention call — which is
 * how this was found, by trying it against the real API before changing config.
 *
 * Losing temperature control matters more than it looks. 0.2 was chosen because
 * this is a judgement task and we have already watched verdicts flip between
 * runs on identical input at that setting. The newer models decide their own
 * sampling; consistency has to come from the prompt instead.
 */
function completionLimits(model: string): Record<string, unknown> {
  const isReasoningFamily = /^gpt-[56]\./.test(model) || /^gpt-6-/.test(model) || /^o\d/.test(model)

  return isReasoningFamily
    // 2500, not 900. Reasoning tokens are drawn from this same budget before
    // any content is produced, so a limit sized for the answer alone gets spent
    // entirely on thinking and returns an empty message. Observed live: two
    // calls in a thirteen-step replay came back with no content at 900, and
    // averaged ~500 output tokens when they succeeded.
    ? { max_completion_tokens: 2500 }
    : { max_tokens: 400, temperature: 0.2 }
}

/**
 * One retry on the failures that are known to be transient.
 *
 * A rate limit used to throw straight out of here, which surfaces as a 500 and
 * loses the turn entirely — the participant's words are already saved, so the
 * only thing that disappears is the mediator's reply, silently, with the room
 * left waiting. Silence is this system's failure mode for everything, so a
 * dropped turn is indistinguishable from a deliberate decision to listen.
 *
 * Mediation is live: a person is waiting in a room, so this retries once and
 * briefly rather than backing off politely for several seconds.
 */
async function callWithRetry(apiKey: string, body: unknown): Promise<Response> {
  const RETRY_STATUSES = new Set([429, 500, 502, 503, 504])

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) return res

    if (attempt === 0 && RETRY_STATUSES.has(res.status)) {
      // Honour Retry-After when the API sends one. The cap was 2s on the
      // reasoning that a late mediator has lost the moment — but the actual
      // rate-limit responses ask for 6-8s, so a 2s cap retried too early, failed
      // again, and lost the turn anyway. A reply eight seconds late is worse
      // than a prompt one and far better than silence, which the room reads as
      // the device being broken.
      const after = Number(res.headers?.get?.('retry-after'))
      const waitMs = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 10_000) : 750
      await new Promise((r) => setTimeout(r, waitMs))
      continue
    }

    const text = await res.text()
    throw new Error(`OpenAI mediation controller failed (${res.status}): ${text}`)
  }

  throw new Error('OpenAI mediation controller failed after retry.')
}

export async function decideIntervention(ctx: MediationContext): Promise<DecisionResult> {
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
    return { decision: { action: 'LISTEN', reasoning: 'Trivial acknowledgement — no mediation value in interrupting.' } }
  }

  const { DEMO_MODE, OPENAI_API_KEY, OPENAI_MODEL } = getEnv()

  if (DEMO_MODE) {
    return { decision: { action: 'LISTEN', reasoning: 'Demo mode — Urushi listens by default; no live model call is made.' } }
  }

  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.')

  const { system, user } = buildInterventionPrompt(ctx)

  const res = await callWithRetry(OPENAI_API_KEY, {
    model: OPENAI_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_object' },
    ...completionLimits(OPENAI_MODEL),
  })

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      prompt_tokens_details?: { cached_tokens?: number }
      completion_tokens_details?: { reasoning_tokens?: number }
    }
  }
  const usage: DecisionUsage = {
    model: OPENAI_MODEL,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    // Reported when a prompt prefix was served from cache. Worth recording
    // separately: the system prompt is identical across a session, so the
    // cache-hit rate is the difference between a cheap session and a dear one.
    cachedInputTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
  }

  const raw = data.choices?.[0]?.message?.content
  if (!raw) {
    // A reasoning model that spends its whole budget thinking returns an empty
    // message. Throwing here surfaces as a 500 and loses the turn, which is the
    // failure mode this system keeps having to design away: silence is
    // indistinguishable from a decision to listen. Better to actually listen,
    // and to say in the record that it was not a choice.
    console.error(
      `[mediationController] ${OPENAI_MODEL} returned no content ` +
      `(finish_reason=${data.choices?.[0]?.finish_reason ?? 'unknown'}, ` +
      `reasoning_tokens=${data.usage?.completion_tokens_details?.reasoning_tokens ?? 0}). Falling back to LISTEN.`
    )
    return {
      decision: { action: 'LISTEN', reasoning: 'Model returned no decision; staying quiet rather than guessing.' },
      usage,
    }
  }


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
  if (directlyAddressed) return { decision: parsed.data, usage }

  const finalAction = enforceCooldown({
    proposedAction: parsed.data.action,
    secondsSinceLastIntervention: ctx.secondsSinceLastIntervention,
  })

  if (finalAction !== parsed.data.action) {
    return {
      decision: { action: finalAction, reasoning: 'Cooldown — Urushi intervened recently; continuing to listen.' },
      usage,
    }
  }

  return { decision: parsed.data, usage }
}
