/**
 * Human voice-command overrides (spec §14). Participants keep control of the floor:
 * they can tell Urushi to back off, or to step in.
 *
 * Deliberately deterministic pattern matching rather than an LLM call — this must
 * be instant and must never itself cost a model round-trip, because it gates
 * whether the expensive intervention path runs at all.
 *
 * BACK_OFF decays rather than permanently muting Urushi: a participant saying
 * "give us a minute" means a minute, not the rest of the meeting. Safety-critical
 * interventions (escalation, personal attacks) still override BACK_OFF — see the
 * engine's urgent-reason path.
 */

export type ParticipationOverride = 'NORMAL' | 'BACK_OFF' | 'STEP_IN'

export interface OverrideState {
  mode: ParticipationOverride
  /** Epoch ms after which the override lapses back to NORMAL. */
  expiresAt: number | null
}

export const NORMAL_OVERRIDE: OverrideState = { mode: 'NORMAL', expiresAt: null }

/** How long "hold on / let us finish" suppresses unsolicited interventions. */
export const BACK_OFF_DURATION_MS = 4 * 60 * 1000
/** STEP_IN is consumed by the next intervention; this is just a safety lapse. */
export const STEP_IN_DURATION_MS = 90 * 1000

/** Urushi must be addressed by name — avoids "hold on" between participants triggering it. */
const ADDRESSED = /\burushi\b/i

const BACK_OFF_PATTERNS: RegExp[] = [
  /\bhold on\b/i,
  /\blet us finish\b/i,
  /\blet me finish\b/i,
  /\bstay out\b/i,
  /\bgive us a (minute|moment|sec)/i,
  /\bdon'?t interrupt\b/i,
  /\bstop interrupting\b/i,
  /\b(be )?quiet\b/i,
  /\bwe'?ll ask you\b/i,
  /\bnot now\b/i,
  /\bback off\b/i,
]

const STEP_IN_PATTERNS: RegExp[] = [
  /\bstep in\b/i,
  /\bwhat do you think\b/i,
  /\bresolve this\b/i,
  /\bhelp us\b/i,
  /\btake over\b/i,
  /\bchair this\b/i,
  /\bweigh in\b/i,
  /\bwhat'?s your (take|view|read)\b/i,
  /\byour thoughts\b/i,
]

export interface DetectedOverride {
  mode: 'BACK_OFF' | 'STEP_IN'
}

/**
 * Detects an override command in an utterance. Returns null when the utterance
 * isn't addressed to Urushi or contains no recognised command.
 */
export function detectOverrideCommand(text: string): DetectedOverride | null {
  if (!ADDRESSED.test(text)) return null

  // STEP_IN is checked first: "Urushi, what do you think?" is an invitation even
  // though a phrase like "hold on" may appear elsewhere in the same sentence.
  if (STEP_IN_PATTERNS.some((p) => p.test(text))) return { mode: 'STEP_IN' }
  if (BACK_OFF_PATTERNS.some((p) => p.test(text))) return { mode: 'BACK_OFF' }
  return null
}

export function applyOverride(detected: DetectedOverride, now: number = Date.now()): OverrideState {
  return {
    mode: detected.mode,
    expiresAt: now + (detected.mode === 'BACK_OFF' ? BACK_OFF_DURATION_MS : STEP_IN_DURATION_MS),
  }
}

/** Resolves a stored override, lapsing it to NORMAL once expired. */
export function resolveOverride(
  stored: { mode?: string | null; expiresAt?: string | number | null } | null | undefined,
  now: number = Date.now()
): OverrideState {
  if (!stored?.mode || stored.mode === 'NORMAL') return NORMAL_OVERRIDE
  const expiresAt = stored.expiresAt == null
    ? null
    : typeof stored.expiresAt === 'number' ? stored.expiresAt : new Date(stored.expiresAt).getTime()

  if (expiresAt !== null && Number.isFinite(expiresAt) && now >= expiresAt) return NORMAL_OVERRIDE
  if (stored.mode !== 'BACK_OFF' && stored.mode !== 'STEP_IN') return NORMAL_OVERRIDE
  return { mode: stored.mode, expiresAt }
}

/**
 * BACK_OFF decays: rather than a hard cliff at expiry, the confidence bar Urushi
 * must clear rises sharply and then eases back toward normal. Returns a multiplier
 * applied to the confidence threshold.
 */
export function overrideThresholdMultiplier(override: OverrideState, now: number = Date.now()): number {
  if (override.mode === 'STEP_IN') return 0
  if (override.mode !== 'BACK_OFF' || override.expiresAt === null) return 1

  const remaining = override.expiresAt - now
  if (remaining <= 0) return 1
  const fraction = Math.min(1, remaining / BACK_OFF_DURATION_MS)
  // Fresh "back off" ≈ 1.35× harder to justify speaking, easing to 1× as it lapses.
  //
  // Deliberately modest: at a typical Facilitator threshold (0.62) a 1.6×
  // multiplier lands at ~0.99, which is a mute in all but name — and the product
  // requirement is that BACK_OFF decays rather than disabling Urushi. 1.35× puts
  // the bar near 0.84, so routine observations are dropped but a genuinely
  // important one still lands.
  return 1 + 0.35 * fraction
}
