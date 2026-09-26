/**
 * Server-only: generates a neutral summary of one person's turn in a Together session.
 * Never import from client components.
 */

import { getEnv } from '@/lib/env'
import { buildMediatorPersona, buildPersonaLanguageReminder } from '@/lib/ai/persona'
import type { ConversationSettings } from '@/lib/conversation/settings'
import { completionParams } from '@/lib/ai/modelParams'

export interface TurnSummaryContext {
  speakerName: string
  otherName: string
  topic: string
  roundNumber: number
  messages: Array<{ content: string; isVoice: boolean }>
  previousSummaries?: Array<{ speaker: string; summary: string; round: number }>
  settings: ConversationSettings
}

export interface TurnSummaryResult {
  summary: string
  inputTokens: number
  outputTokens: number
}

export async function generateTurnSummary(ctx: TurnSummaryContext): Promise<TurnSummaryResult> {
  const { OPENAI_API_KEY, OPENAI_MODEL, DEMO_MODE } = getEnv()

  if (DEMO_MODE) {
    return {
      summary: `${ctx.speakerName} shared their perspective on ${ctx.topic}. They described their main concern and what they would like the other person to understand. They expressed a desire for a constructive resolution.`,
      inputTokens: 0,
      outputTokens: 0,
    }
  }

  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.')

  const previousContext = ctx.previousSummaries && ctx.previousSummaries.length > 0
    ? `\n\n# Previous round summaries\n${ctx.previousSummaries.map(s => `Round ${s.round} — ${s.speaker}: ${s.summary}`).join('\n\n')}`
    : ''

  const messagesText = ctx.messages.map((m, i) =>
    `Message ${i + 1}${m.isVoice ? ' (voice recording)' : ''}: ${m.content}`
  ).join('\n\n')

  const persona = ctx.settings ? `${buildMediatorPersona(ctx.settings, { written: true, record: true })}\n\n` : ''
  // Only works in final position, which is why it is appended rather than folded
  // into the persona block above.
  const languageReminder = ctx.settings ? buildPersonaLanguageReminder(ctx.settings) : ''

  const system = `${persona}You are a neutral conflict-resolution facilitator summarising what one participant said during their turn in a joint mediation session.

# Your task
Create a concise, neutral summary of ${ctx.speakerName}'s turn (round ${ctx.roundNumber}).

The summary must capture:
1. What happened from ${ctx.speakerName}'s perspective (specific incidents or behaviours, not general complaints)
2. Their main concern — what they need ${ctx.otherName} to understand
3. Any desired outcome or change they mentioned
4. Important facts or context they believe are missing
5. Any acknowledgement, responsibility or repair they offered
6. What they have not yet had the chance to say (if they indicated this)

# Rules
- Write in third person ("${ctx.speakerName} feels that...", "${ctx.speakerName} described...")
- Do NOT judge who is correct
- Do NOT diagnose either person
- Do NOT use labels like "abusive", "narcissistic", "toxic"
- Clearly attribute all disputed facts to ${ctx.speakerName}'s account
- Preserve important nuance — do not flatten a complex position
- Length: 100–200 words
- Plain prose, no bullet points, no headers

Return only the summary text. No preamble, no JSON wrapper.${languageReminder ? `\n\n${languageReminder}` : ''}`

  const user = `Conversation topic: ${ctx.topic}${previousContext}

# ${ctx.speakerName}'s messages this round

${messagesText}`

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...completionParams(OPENAI_MODEL, 400, 0.3),
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OpenAI turn summary failed (${res.status}): ${text}`)
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens: number; completion_tokens: number }
  }

  const summary = data.choices?.[0]?.message?.content?.trim()
  if (!summary) throw new Error('Empty summary response from OpenAI.')

  return {
    summary,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  }
}
