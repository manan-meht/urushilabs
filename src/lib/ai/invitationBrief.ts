/**
 * Server-only: generates the neutral Invitation Brief shown to Party B.
 * Never import from client components.
 */

import { z } from 'zod'
import { getEnv } from '@/lib/env'
import { buildMediatorPersona, buildPersonaLanguageReminder } from './persona'
import type { ConversationSettings } from '@/lib/conversation/settings'
import type { InvitationBrief } from '@/lib/db/types'

export const INVITATION_BRIEF_VERSION = '1.0'

export const InvitationBriefSchema = z.object({
  title: z.string().min(1),
  reasonForConversation: z.string().min(1),
  issueFromPartyAPerspective: z.string().min(1),
  hopedForOutcome: z.string().min(1),
  invitationToRespond: z.string().min(1),
}).strict()

export type ValidatedInvitationBrief = z.infer<typeof InvitationBriefSchema>

export interface BriefGenerationContext {
  initiatorName: string
  recipientName: string
  topic: string
  initiatorSummaryJson: string  // The Party A private summary JSON string
  settings: ConversationSettings
}

function buildBriefSystemPrompt(ctx: BriefGenerationContext): string {
  // Party B has not been heard yet, so the foundation's one-sided-account rules
  // apply to the brief as much as to the intake that produced it.
  const persona = ctx.settings ? `${buildMediatorPersona(ctx.settings, { written: true, record: true })}\n\n` : ''
  // Only works in final position, which is why it is appended rather than folded
  // into the persona block above.
  const languageReminder = ctx.settings ? buildPersonaLanguageReminder(ctx.settings) : ''

  return `${persona}# Identity

You are preparing a neutral Invitation Brief for a second participant (${ctx.recipientName}) in a conflict-resolution conversation.

You have heard only ${ctx.initiatorName}'s perspective. Your task is NOT to decide whether ${ctx.initiatorName} is correct. Create a concise but meaningful description of what ${ctx.initiatorName} would like to discuss so that ${ctx.recipientName} can understand the context and decide how to respond.

# Rules

- Clearly attribute ALL disputed information to ${ctx.initiatorName}'s perspective.
- Do not present allegations, interpretations, or motives as facts.
- Do not assign blame, diagnose, or describe either participant's character.
- Do not use emotionally loaded labels.
- Do not pressure ${ctx.recipientName} to apologise or accept ${ctx.initiatorName}'s interpretation.
- Never say "you caused", "you failed to", "your behaviour has", or "you need to accept".
- Do use phrases such as: "${ctx.initiatorName} feels that…", "From ${ctx.initiatorName}'s perspective…", "${ctx.initiatorName} has described…", "${ctx.initiatorName} would like to better understand…"
- The brief must be detailed enough to be meaningful but short enough to read before starting a conversation (aim for 150–250 words total across all fields).
- Do not include the AI's preliminary judgement.
- Do not reveal sensitive private information such as safety signals or diagnostic observations.

# Output

Return a JSON object with exactly these fields:

{
  "title": "What you are being invited to discuss",
  "reasonForConversation": "A 2–3 sentence neutral explanation of why ${ctx.initiatorName} started this conversation.",
  "issueFromPartyAPerspective": "A 3–5 sentence neutral description of the issue as ${ctx.initiatorName} currently understands it, clearly attributed to their perspective.",
  "hopedForOutcome": "A 1–2 sentence description of what ${ctx.initiatorName} hopes the conversation can achieve.",
  "invitationToRespond": "A 2–3 sentence respectful invitation telling ${ctx.recipientName} that: they have not been judged; ${ctx.initiatorName}'s account is only one perspective; they will have a full opportunity to explain their own experience; and they do not need to agree with ${ctx.initiatorName}'s description."
}

No markdown, no preamble, no wrapper object, no explanation outside the JSON. Return only the JSON object.${languageReminder ? `\n\n${languageReminder}` : ''}`
}

function buildBriefUserMessage(ctx: BriefGenerationContext): string {
  return `# Conflict topic
${ctx.topic}

# ${ctx.initiatorName}'s private account (structured summary)
${ctx.initiatorSummaryJson}

# Task
Generate the Invitation Brief for ${ctx.recipientName} following the rules above. Remember to attribute all claims to ${ctx.initiatorName}'s perspective — never as established fact.`
}

export async function generateInvitationBrief(ctx: BriefGenerationContext): Promise<InvitationBrief> {
  const { OPENAI_API_KEY, OPENAI_MODEL, DEMO_MODE } = getEnv()

  if (DEMO_MODE) {
    return {
      title: 'What you are being invited to discuss',
      reasonForConversation: `${ctx.initiatorName} has started this conversation because they feel there is an unresolved disagreement about ${ctx.topic}. They would like the opportunity for both of you to share your perspectives with the help of an impartial facilitator.`,
      issueFromPartyAPerspective: `From ${ctx.initiatorName}'s perspective, there have been some misunderstandings about how certain situations were handled. They feel that their concerns may not have been fully understood and that you may have had different expectations about how things should proceed.`,
      hopedForOutcome: `${ctx.initiatorName} hopes that this conversation will help clarify what each of you expected and find a more workable way forward.`,
      invitationToRespond: `No conclusions have been reached. This summary reflects only ${ctx.initiatorName}'s current understanding, and you do not need to agree with it. You will have a full opportunity to describe your own experience and correct any assumptions before any shared assessment is prepared.`,
    }
  }

  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.')

  // Use fetch directly rather than the OpenAI SDK to avoid the Node.js HTTP
  // internals that hang silently in the Cloudflare Workers runtime.
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: buildBriefSystemPrompt(ctx) },
        { role: 'user', content: buildBriefUserMessage(ctx) },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 600,
      temperature: 0.3,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OpenAI brief generation failed (${res.status}): ${text}`)
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  const raw = data.choices?.[0]?.message?.content
  if (!raw) throw new Error('Empty response from OpenAI.')

  const parsed = InvitationBriefSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error(`Brief schema validation failed: ${parsed.error.message}`)

  return parsed.data
}

/**
 * Builds a context-aware opening message for Party B's intake conversation.
 * Uses the brief so Party B understands the context before responding.
 * No AI call — deterministic template.
 */
export function buildPartyBOpeningMessage(brief: InvitationBrief, recipientName: string): string {
  return `${brief.issueFromPartyAPerspective}

How do you experience this situation, ${recipientName}? What do you think is most important for Urushi Labs to understand about your perspective? Please share what happened from your point of view — you can correct anything you believe is inaccurate or add context that was missed.`
}
