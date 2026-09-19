/**
 * Analysis service — server-only.
 * Decrypts both submissions, calls OpenAI, validates output.
 */

import OpenAI from 'openai'
import {
  buildMediationSystemPrompt,
  buildMediationUserMessage,
  SharedReportSchema,
  MEDIATION_PROMPT_VERSION,
  type ValidatedSharedReport,
  type MediationContext,
} from './mediationPrompt'
import { getEnv } from '@/lib/env'
import { MOCK_REPORT } from './mockReport'

export interface AnalysisResult {
  report: ValidatedSharedReport
  inputTokens: number
  outputTokens: number
}

export async function runAnalysis(ctx: MediationContext): Promise<AnalysisResult> {
  const { OPENAI_MODEL, OPENAI_API_KEY, DEMO_MODE } = getEnv()

  if (DEMO_MODE) {
    await new Promise((r) => setTimeout(r, 1000))  // simulate processing time
    return { report: MOCK_REPORT, inputTokens: 0, outputTokens: 0 }
  }

  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured. Cannot run analysis.')
  }

  const client = new OpenAI({ apiKey: OPENAI_API_KEY, fetch: globalThis.fetch })
  const systemPrompt = buildMediationSystemPrompt(ctx.settings)
  const userMessage = buildMediationUserMessage(ctx)

  const response = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 8000,
    temperature: 0.4,
  })

  const finishReason = response.choices[0]?.finish_reason
  if (finishReason === 'length') {
    throw new Error('OpenAI response was cut off (max_tokens reached). The submissions may be too long.')
  }

  const rawContent = response.choices[0]?.message?.content
  if (!rawContent) throw new Error('Empty response from OpenAI analysis.')

  // Strip markdown code fences if OpenAI wrapped the JSON despite instructions
  const stripped = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    console.error('[analysis] Raw OpenAI output (first 500 chars):', rawContent.slice(0, 500))
    throw new Error('OpenAI returned invalid JSON in analysis response.')
  }

  // OpenAI sometimes wraps the object in a single root key e.g. { "report": {...} }
  // Unwrap it if the top-level has exactly one key and the value is an object.
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const keys = Object.keys(parsed as Record<string, unknown>)
    if (keys.length === 1) {
      const inner = (parsed as Record<string, unknown>)[keys[0]!]
      if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
        parsed = inner
      }
    }
  }

  const result = SharedReportSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`OpenAI analysis response failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}`)
  }

  return {
    report: result.data,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  }
}

export { MEDIATION_PROMPT_VERSION }
