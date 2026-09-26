/**
 * Server-only: generates the final structured report at the end of a Together session.
 * Never import from client components.
 */

import { z } from 'zod'
import { getEnv } from '@/lib/env'
import { buildMediatorPersona, buildPersonaLanguageReminder } from '@/lib/ai/persona'
import type { ConversationSettings } from '@/lib/conversation/settings'
import type { SafetyCategory } from '@/lib/db/types'
import { completionParams } from '@/lib/ai/modelParams'

const AgreedItemSchema = z.object({
  title: z.string().min(1),
  personAAction: z.string(),
  personBAction: z.string(),
  sharedAction: z.string().optional(),
  dueDate: z.string().optional(),
  reviewDate: z.string().optional(),
})

const PartialItemSchema = z.object({
  title: z.string().min(1),
  agreedParts: z.string().min(1),
  unsettled: z.string().min(1),
})

const UnresolvedItemSchema = z.object({
  title: z.string().min(1),
  personAPosition: z.string().min(1),
  personBPosition: z.string().min(1),
  suggestedNextStep: z.string().min(1),
  revisitLater: z.boolean(),
})

export const FinalReportSchema = z.object({
  agreed: z.array(AgreedItemSchema),
  partiallyAgreed: z.array(PartialItemSchema),
  notResolved: z.array(UnresolvedItemSchema),
  sharedUnderstanding: z.string().min(1),
  safetyCategory: z.enum([
    'ordinary_conflict', 'high_conflict', 'possible_coercion_or_abuse',
    'possible_self_harm_or_violence', 'possible_child_safety_issue',
    'legal_or_professional_support_needed',
  ]),
  safetyNote: z.string().optional(),
})

export type FinalReport = z.infer<typeof FinalReportSchema>

export interface FinalReportContext {
  personAName: string
  personBName: string
  topic: string
  personASummary: string
  personBSummary: string
  sharedUnderstandingSummary: string
  issueResolutions: Array<{
    title: string
    status: string
    resolution?: string
    personAPosition?: string
    personBPosition?: string
  }>
  allMessages: Array<{ speaker: string; content: string; round: number }>
  settings: ConversationSettings
}

export interface FinalReportResult {
  report: FinalReport
  inputTokens: number
  outputTokens: number
}

export async function generateFinalReport(ctx: FinalReportContext): Promise<FinalReportResult> {
  const { OPENAI_API_KEY, OPENAI_MODEL, DEMO_MODE } = getEnv()

  if (DEMO_MODE) {
    return {
      report: {
        agreed: [{
          title: 'Commitment to ongoing communication',
          personAAction: `${ctx.personAName} will raise concerns promptly.`,
          personBAction: `${ctx.personBName} will listen without interrupting.`,
          sharedAction: 'Both will check in weekly.',
        }],
        partiallyAgreed: [],
        notResolved: [],
        sharedUnderstanding: `${ctx.personAName} and ${ctx.personBName} have each shared their perspectives on ${ctx.topic}. While they see the situation differently in some respects, they share a commitment to finding a way forward together.`,
        safetyCategory: 'ordinary_conflict',
      },
      inputTokens: 0,
      outputTokens: 0,
    }
  }

  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.')

  const issueText = ctx.issueResolutions.map(i =>
    `Issue: ${i.title}\nStatus: ${i.status}${i.resolution ? `\nResolution: ${i.resolution}` : ''}${i.personAPosition ? `\n${ctx.personAName}'s position: ${i.personAPosition}` : ''}${i.personBPosition ? `\n${ctx.personBName}'s position: ${i.personBPosition}` : ''}`
  ).join('\n\n')

  const persona = ctx.settings ? `${buildMediatorPersona(ctx.settings, { written: true, record: true })}\n\n` : ''
  // Only works in final position, which is why it is appended rather than folded
  // into the persona block above.
  const languageReminder = ctx.settings ? buildPersonaLanguageReminder(ctx.settings) : ''

  const system = `${persona}You are a neutral conflict-resolution facilitator producing the final report after a joint mediation session.

# Task
Synthesise the session into a structured final report.

# Rules
- Do NOT invent agreements that were not expressed
- Do NOT assign blame
- For agreed items, be specific about who does what
- For unresolved items, describe each person's position neutrally
- Identify safety category honestly (ordinary_conflict is appropriate for normal disagreement)
- safetyNote required only if category is not ordinary_conflict or high_conflict
- sharedUnderstanding: 2–4 sentence narrative suitable for both people to read together

# Output — JSON only
{
  "agreed": [{ "title": "...", "personAAction": "...", "personBAction": "...", "sharedAction": "...", "dueDate": "...", "reviewDate": "..." }],
  "partiallyAgreed": [{ "title": "...", "agreedParts": "...", "unsettled": "..." }],
  "notResolved": [{ "title": "...", "personAPosition": "...", "personBPosition": "...", "suggestedNextStep": "...", "revisitLater": true/false }],
  "sharedUnderstanding": "...",
  "safetyCategory": "ordinary_conflict",
  "safetyNote": "..."
}

No preamble. No markdown fences. Return only the JSON object.${languageReminder ? `\n\n${languageReminder}` : ''}`

  const user = `Conversation topic: ${ctx.topic}

${ctx.personAName}'s approved summary: ${ctx.personASummary}

${ctx.personBName}'s approved summary: ${ctx.personBSummary}

Shared understanding: ${ctx.sharedUnderstandingSummary}

Issue resolutions:
${issueText}`

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      ...completionParams(OPENAI_MODEL, 2500, 0.3),
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OpenAI final report failed (${res.status}): ${text}`)
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens: number; completion_tokens: number }
  }

  const raw = data.choices?.[0]?.message?.content
  if (!raw) throw new Error('Empty response from OpenAI.')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('OpenAI returned invalid JSON for final report.')
  }

  const validated = FinalReportSchema.safeParse(parsed)
  if (!validated.success) {
    throw new Error(`Final report schema validation failed: ${validated.error.message}`)
  }

  // Ensure safetyCategory is cast correctly
  const report = validated.data as FinalReport & { safetyCategory: SafetyCategory }

  return {
    report,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  }
}
