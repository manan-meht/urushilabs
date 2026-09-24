/**
 * What a model call costs, in one place.
 *
 * Exists because the profitability of a mediation was, until now, unanswerable:
 * meeting_usage had exactly the right columns and every row was zeros,
 * cases.openai_input_tokens was referenced by code and absent from the database,
 * and room mode recorded nothing at all. Every cost figure was an estimate built
 * from prompt sizes and call counts.
 *
 * Rates are US dollars per MILLION tokens, matching how OpenAI publishes them,
 * and are stored as a table rather than scattered so that a price change is one
 * edit. They WILL drift — check them against platform.openai.com/docs/pricing
 * rather than trusting this file's age.
 */

export interface ModelRate {
  /** USD per 1M input tokens. */
  inputPerMillion: number
  /** USD per 1M output tokens. */
  outputPerMillion: number
  /** USD per 1M cached input tokens, where the model supports prompt caching. */
  cachedInputPerMillion?: number
}

export const MODEL_RATES: Record<string, ModelRate> = {
  // Legacy — no longer on the published pricing page. Historical rate.
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10, cachedInputPerMillion: 1.25 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  // Current families.
  'gpt-6-astra': { inputPerMillion: 10, outputPerMillion: 50, cachedInputPerMillion: 1 },
  'gpt-6-sol': { inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 0.2 },
  'gpt-6-luna': { inputPerMillion: 0.1, outputPerMillion: 0.5, cachedInputPerMillion: 0.01 },
}

/** Realtime audio, billed separately and per modality. */
export const REALTIME_AUDIO_RATES: Record<string, ModelRate> = {
  'gpt-realtime-2.1': { inputPerMillion: 32, outputPerMillion: 64, cachedInputPerMillion: 0.4 },
  'gpt-realtime-2.1-mini': { inputPerMillion: 10, outputPerMillion: 20, cachedInputPerMillion: 0.3 },
}

/** USD per minute for transcription models. */
export const TRANSCRIPTION_PER_MINUTE: Record<string, number> = {
  'gpt-4o-transcribe': 0.006,
  'gpt-4o-mini-transcribe': 0.003,
  'gpt-transcribe': 0.0045,
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** Input tokens served from cache, when the API reports them. */
  cachedInputTokens?: number
}

/**
 * Cost of one call, in USD.
 *
 * An unknown model returns 0 rather than throwing. A missing rate must never
 * take down a mediation — the whole point of recording this is that it happens
 * beside the work, not in its way.
 */
export function costOf(model: string, usage: TokenUsage, rates = MODEL_RATES): number {
  const rate = rates[model]
  if (!rate) return 0

  const cached = usage.cachedInputTokens ?? 0
  const uncached = Math.max(usage.inputTokens - cached, 0)

  return (
    (uncached * rate.inputPerMillion) / 1_000_000 +
    (cached * (rate.cachedInputPerMillion ?? rate.inputPerMillion)) / 1_000_000 +
    (usage.outputTokens * rate.outputPerMillion) / 1_000_000
  )
}

/** Whether we have a published rate for this model, for reporting gaps. */
export function hasRate(model: string, rates = MODEL_RATES): boolean {
  return model in rates
}
