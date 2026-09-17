/**
 * Deterministic, pure guardrails around the meeting mediation controller — same
 * role as src/lib/ai/room/interventionGuardrails.ts for Live Mediation. Kept as a
 * separate copy (not a shared import) so Live Mediation's file is never touched
 * by Meeting Mediation work; the two are allowed to diverge over time as each
 * transport's needs differ (e.g. meeting audio quality, longer natural pauses).
 */

import type { MeetingInterventionAction } from '@/lib/db/types'

const TRIVIAL_ACK_PATTERN =
  /^(yes|yeah|yep|yup|no|nope|nah|ok(ay)?|right|sure|mm+h?m*|uh+[- ]?huh|totally|exactly|fair|agreed?|true|correct)[.!?]?$/i

export function isTrivialUtterance(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  const words = trimmed.split(/\s+/)
  if (words.length > 3) return false
  return TRIVIAL_ACK_PATTERN.test(trimmed.replace(/[,]/g, ''))
}

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

const COOLDOWN_BYPASS_ACTIONS: ReadonlySet<MeetingInterventionAction> = new Set(['DEESCALATE', 'END_SESSION'])

export function enforceCooldown(opts: {
  proposedAction: MeetingInterventionAction
  secondsSinceLastIntervention: number
  cooldownSeconds?: number
}): MeetingInterventionAction {
  const { proposedAction, secondsSinceLastIntervention, cooldownSeconds = DEFAULT_COOLDOWN_SECONDS } = opts

  if (proposedAction === 'LISTEN') return 'LISTEN'
  if (COOLDOWN_BYPASS_ACTIONS.has(proposedAction)) return proposedAction
  if (secondsSinceLastIntervention < cooldownSeconds) return 'LISTEN'
  return proposedAction
}
