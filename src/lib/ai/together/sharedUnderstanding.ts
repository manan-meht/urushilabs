/**
 * Server-only: generates the shared understanding and issue list after both parties
 * have approved their turn summaries and confirmed readiness.
 * Never import from client components.
 */

import { z } from 'zod'
import { getEnv } from '@/lib/env'
import { buildMediatorPersona, buildPersonaLanguageReminder } from '@/lib/ai/persona'
import type { ConversationSettings } from '@/lib/conversation/settings'

const AgreementSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
})

const DifferenceSchema = z.object({
  title: z.string().min(1),
  personAPerspective: z.string().min(1),
  personBPerspective: z.string().min(1),
  neutralDescription: z.string().min(1),
})

const IssueSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  neutralDescription: z.string().min(1),
  priority: z.number().int().min(1),
})

export const SharedUnderstandingSchema = z.object({
  personASummary: z.string().min(1),
  personBSummary: z.string().min(1),
  agreements: z.array(AgreementSchema),
  differences: z.array(DifferenceSchema),
  issues: z.array(IssueSchema).min(1),
})

export type SharedUnderstanding = z.infer<typeof SharedUnderstandingSchema>

export interface SharedUnderstandingContext {
  personAName: string
  personBName: string
  topic: string
  personASummaries: Array<{ round: number; summary: string }>
  personBSummaries: Array<{ round: number; summary: string }>
  settings: ConversationSettings
}

export interface SharedUnderstandingResult {
  understanding: SharedUnderstanding
  inputTokens: number
  outputTokens: number
}

export async function generateSharedUnderstanding(
  ctx: SharedUnderstandingContext
): Promise<SharedUnderstandingResult> {
  const { OPENAI_API_KEY, OPENAI_MODEL, DEMO_MODE } = getEnv()

  if (DEMO_MODE) {
    return {
      understanding: {
        personASummary: `${ctx.personAName} has shared their perspective on ${ctx.topic} and wants to find a constructive way forward.`,
        personBSummary: `${ctx.personBName} has shared their perspective and also wants to find a resolution that works for both of them.`,
        agreements: [{ title: 'Desire for resolution', description: 'Both people want to find a way forward.' }],
        differences: [
          {
            title: 'Different accounts of events',
            personAPerspective: `${ctx.personAName} describes the situation differently.`,
            personBPerspective: `${ctx.personBName} has a different account.`,
            neutralDescription: 'The two accounts of events differ and cannot currently be reconciled without more information.',
          },
        ],
        issues: [
          { id: 'issue-1', title: ctx.topic, neutralDescription: 'The core topic that needs to be resolved.', priority: 1 },
        ],
      },
      inputTokens: 0,
      outputTokens: 0,
    }
  }

  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.')

  const formatSummaries = (name: string, summaries: Array<{ round: number; summary: string }>) =>
    summaries.map(s => `Round ${s.round}:\n${s.summary}`).join('\n\n')

  const persona = ctx.settings ? `${buildMediatorPersona(ctx.settings, { written: true, record: true })}\n\n` : ''
  // Only works in final position, which is why it is appended rather than folded
  // into the persona block above.
  const languageReminder = ctx.settings ? buildPersonaLanguageReminder(ctx.settings) : ''

  const system = `${persona}You are a neutral conflict-resolution facilitator. Both participants have shared their perspectives and approved their summaries. Your task is to generate a structured shared understanding.

# Rules
- Do NOT decide who is right
- Do NOT invent concessions or agreements that were not expressed
- Do NOT use diagnostic language
- Attribute disputed facts clearly (e.g. "${ctx.personAName} believes... while ${ctx.personBName} describes...")
- Identify genuine shared ground — even small agreements matter
- Separate issues into specific, manageable topics (not one big blob)
- Issue IDs must be simple strings like "issue-1", "issue-2"
- Priority 1 = most urgent/important, incrementing from there

# Output — JSON only
{
  "personASummary": "2–3 sentence distillation of ${ctx.personAName}'s overall position",
  "personBSummary": "2–3 sentence distillation of ${ctx.personBName}'s overall position",
  "agreements": [{ "title": "Short title", "description": "What they both agree on" }],
  "differences": [{
    "title": "Short title",
    "personAPerspective": "${ctx.personAName}'s view",
    "personBPerspective": "${ctx.personBName}'s view",
    "neutralDescription": "Neutral framing of the disagreement"
  }],
  "issues": [{
    "id": "issue-1",
    "title": "Specific issue title",
    "neutralDescription": "Neutral 1–2 sentence description",
    "priority": 1
  }]
}

No preamble. No markdown fences. Return only the JSON object.${languageReminder ? `\n\n${languageReminder}` : ''}`

  const user = `Conversation topic: ${ctx.topic}

# ${ctx.personAName}'s approved summaries (all rounds)
${formatSummaries(ctx.personAName, ctx.personASummaries)}

# ${ctx.personBName}'s approved summaries (all rounds)
${formatSummaries(ctx.personBName, ctx.personBSummaries)}`

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      max_tokens: 2000,
      temperature: 0.3,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OpenAI shared understanding failed (${res.status}): ${text}`)
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
    throw new Error('OpenAI returned invalid JSON for shared understanding.')
  }

  const validated = SharedUnderstandingSchema.safeParse(parsed)
  if (!validated.success) {
    throw new Error(`Shared understanding schema validation failed: ${validated.error.message}`)
  }

  return {
    understanding: validated.data,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  }
}
