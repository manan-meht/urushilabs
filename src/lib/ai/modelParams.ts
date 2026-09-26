/**
 * Per-model completion parameters, in ONE place.
 *
 * This exists because it was not in one place. `gpt-6-luna` rejects both
 * `max_tokens` (it wants `max_completion_tokens`) and any `temperature` other
 * than the default, and when the controller switched to it the fix was applied
 * to exactly one of fourteen call sites. Every other AI feature in the product
 * — intake, invitation briefs, analysis, all four Together steps, the meeting
 * intervention engine, three final reports, and the spoken opening — started
 * answering HTTP 400.
 *
 * The failures were not equally visible, which is why it survived a deploy.
 * Intake returned 500s. Together caught the error, logged it, and returned 200
 * with a null safety review. The room mode believed tested kept working for
 * live interventions and silently produced no final report. And 626 tests
 * passed throughout, because only six of them stub fetch and none assert what
 * is in the request body.
 *
 * So: one function, every call site. A future model switch changes this file.
 */

/**
 * Models that bill and budget reasoning tokens, and reject the older
 * parameters. Matched by family prefix rather than an allowlist, so a new
 * member of a known family is handled rather than silently mis-parameterised.
 */
function isReasoningFamily(model: string): boolean {
  return /^gpt-[6-9]/.test(model) || /^gpt-5\.[6-9]/.test(model) || /^o\d/.test(model)
}

export interface CompletionParams {
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
}

/**
 * The token-limit and sampling parameters this model will accept.
 *
 * `maxOutputTokens` is the budget for the ANSWER. Reasoning models draw their
 * thinking from the same allowance before emitting any content, so that budget
 * is multiplied for them — sized for the answer alone, the whole allowance goes
 * on reasoning and the response comes back empty. Observed at a 1:6 ratio in
 * the room controller, so the multiplier is deliberately generous; an unused
 * ceiling costs nothing, an exhausted one costs the turn.
 *
 * `temperature` is dropped entirely for reasoning models, which only accept the
 * default. Callers still pass their intent, so it comes back the moment a model
 * supports it again.
 */
export function completionParams(
  model: string,
  maxOutputTokens: number,
  temperature?: number
): CompletionParams {
  if (isReasoningFamily(model)) {
    return { max_completion_tokens: Math.max(maxOutputTokens * 6, 1500) }
  }
  return {
    max_tokens: maxOutputTokens,
    ...(temperature === undefined ? {} : { temperature }),
  }
}

/**
 * Whether a response was cut short by the token ceiling.
 *
 * Reasoning models hit this differently — they can exhaust the budget while
 * thinking and return a finish_reason of 'length' with empty content, which
 * reads as a model failure rather than a truncation unless it is named.
 */
export function wasTruncated(finishReason: string | undefined): boolean {
  return finishReason === 'length'
}
