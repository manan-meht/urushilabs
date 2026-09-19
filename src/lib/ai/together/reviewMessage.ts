/**
 * Server-only: reviews a Together Mode message for safety and constructiveness.
 * Returns a classification and optional reframe. Never import from client components.
 */

import { z } from 'zod'
import { getEnv } from '@/lib/env'
import { buildMediatorPersona, buildPersonaLanguageReminder } from '@/lib/ai/persona'
import type { ConversationSettings } from '@/lib/conversation/settings'

export const MessageReviewSchema = z.object({
  classification: z.enum(['display_as_written', 'offer_reframe', 'block_or_safety_intervention']),
  originalMeaningSummary: z.string().min(1),
  suggestedReframe: z.string().optional(),
  reason: z.string().optional(),
})

export type MessageReview = z.infer<typeof MessageReviewSchema>

export async function reviewMessage(opts: {
  speakerName: string
  otherName: string
  topic: string
  content: string
  /**
   * Optional so that callers with no case to read settings from keep the
   * pre-persona behaviour exactly.
   */
  settings?: ConversationSettings
}): Promise<MessageReview> {
  const { OPENAI_API_KEY, OPENAI_MODEL, DEMO_MODE } = getEnv()

  if (DEMO_MODE) {
    return {
      classification: 'display_as_written',
      originalMeaningSummary: opts.content,
    }
  }

  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.')

  // A reframe is text the speaker will send as their own, so it has to come out
  // in the same language and register as the rest of the conversation.
  // record: this rewrites a PARTICIPANT's own message for the other person to
  // read. Urushi putting swearing into someone else's words is not what anyone
  // agreed to, however the mediator is allowed to talk in its own voice.
  const persona = opts.settings ? `${buildMediatorPersona(opts.settings, { written: true, record: true })}\n\n` : ''
  // Only works in final position, which is why it is appended rather than folded
  // into the persona block above.
  const languageReminder = opts.settings ? buildPersonaLanguageReminder(opts.settings) : ''

  const system = `${persona}You are a neutral conflict-resolution facilitator reviewing a message submitted during a joint mediation session.

Both participants are physically present. Your task is to classify this message and, where helpful, suggest a reframe that preserves the speaker's concern while reducing language likely to trigger defensiveness.

# Classification rules

"display_as_written"
- Normal disagreement, frustration, criticism, or factual dispute
- Emotionally honest but not aimed at harming the other person
- Blunt but not abusive

"offer_reframe"
- Contains insults, contempt, sweeping character attacks, or language likely to shut the conversation down
- Still contains a genuine underlying concern that can be preserved
- A reframe would meaningfully help

"block_or_safety_intervention"
- Explicit threats of physical harm
- Coercive or controlling language designed to intimidate
- Content that suggests immediate safety risk

# Rules for reframes
- Preserve the speaker's actual meaning and concern. Do not weaken or dismiss it.
- Do not turn a real complaint into a compliment.
- Convert "you always..." → "I've experienced..." or "from my perspective..."
- Convert insults → descriptions of behaviour and its impact
- Keep the reframe the speaker's voice, not Urushi's summary.

# Output
Return JSON only, no preamble:
{
  "classification": "display_as_written" | "offer_reframe" | "block_or_safety_intervention",
  "originalMeaningSummary": "One sentence: the real concern underneath this message",
  "suggestedReframe": "Rewritten message (only if classification is offer_reframe)",
  "reason": "One sentence explaining the classification (only if not display_as_written)"
}${languageReminder ? `\n\n${languageReminder}` : ''}`

  const user = `Conversation topic: ${opts.topic}

${opts.speakerName} (to ${opts.otherName}): "${opts.content}"

Review and classify this message.`

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
    throw new Error(`OpenAI message review failed (${res.status}): ${text}`)
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens: number; completion_tokens: number } }
  const raw = data.choices?.[0]?.message?.content
  if (!raw) throw new Error('Empty response from OpenAI.')

  const parsed = MessageReviewSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error(`Message review schema validation failed: ${parsed.error.message}`)

  return { ...parsed.data, _usage: data.usage } as MessageReview & { _usage?: unknown }
}
