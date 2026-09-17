/**
 * Deterministic, pure guardrails around the mediation controller. These run before
 * (and after) any LLM call so the common "say nothing" case never touches the
 * network, and so a single misjudged model response can't make Urushi talk too often.
 *
 * This is what actually enforces "LISTEN should be the most common action" — not
 * the system prompt alone.
 */

import type { RoomInterventionAction } from '@/lib/db/types'

/** Urushi should never speak in response to bare acknowledgements. */
const TRIVIAL_ACK_PATTERN =
  /^(yes|yeah|yep|yup|no|nope|nah|ok(ay)?|right|sure|mm+h?m*|uh+[- ]?huh|totally|exactly|fair|agreed?|true|correct)[.!?]?$/i

export function isTrivialUtterance(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  const words = trimmed.split(/\s+/)
  if (words.length > 3) return false
  return TRIVIAL_ACK_PATTERN.test(trimmed.replace(/[,]/g, ''))
}

/**
 * Cheap, curated signal for character attacks / contempt / escalating insults —
 * distinct from ordinary disagreement, frustration, or blunt criticism, which
 * Urushi should generally NOT interrupt (see spec §13). Intentionally narrow:
 * false negatives are safer than false positives here, since the LLM classifier
 * is still the primary judgment — this only decides whether to bypass the
 * trivial-utterance fast path and whether cooldown can be bypassed.
 */
const ESCALATION_PATTERNS: RegExp[] = [
  /impossible to work with/i,
  /you('re| are) (just )?(impossible|useless|pathetic|worthless|stupid|an? idiot|a joke|unbelievable)/i,
  /you never (listen|care|help|change)/i,
  /you always (do this|ruin|mess up|ignore)/i,
  /shut up/i,
  /whatever,? i('m| am) done/i,
  /this is (pointless|a waste of time)/i,
  /(idiot|pathetic|worthless|stupid|moron)/i,
]

export function detectEscalationSignal(text: string): boolean {
  return ESCALATION_PATTERNS.some((pattern) => pattern.test(text))
}

export const DEFAULT_COOLDOWN_SECONDS = 20

/** Actions important enough to bypass the cooldown between spoken interventions. */
const COOLDOWN_BYPASS_ACTIONS: ReadonlySet<RoomInterventionAction> = new Set(['DEESCALATE', 'END_SESSION'])

/**
 * Downgrades a proposed spoken intervention to LISTEN if Urushi intervened too
 * recently, unless the action is important enough to bypass the cooldown.
 * Never touches LISTEN itself.
 */
export function enforceCooldown(opts: {
  proposedAction: RoomInterventionAction
  secondsSinceLastIntervention: number
  cooldownSeconds?: number
}): RoomInterventionAction {
  const { proposedAction, secondsSinceLastIntervention, cooldownSeconds = DEFAULT_COOLDOWN_SECONDS } = opts

  if (proposedAction === 'LISTEN') return 'LISTEN'
  if (COOLDOWN_BYPASS_ACTIONS.has(proposedAction)) return proposedAction
  if (secondsSinceLastIntervention < cooldownSeconds) return 'LISTEN'
  return proposedAction
}
