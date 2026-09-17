/**
 * Minimal feature-flag mechanism — env-var based, following the same pattern as
 * DEMO_MODE. No external flag service exists in this codebase; this is intentionally
 * the simplest thing that lets us roll Live Mediation out to selected users first.
 */

import { getEnv } from '@/lib/env'

/**
 * Live Mediation is enabled globally via LIVE_MEDIATION_ENABLED=true, or per-user via
 * a comma-separated LIVE_MEDIATION_ALLOWED_EMAILS allowlist (case-insensitive).
 */
export function isLiveMediationEnabled(userEmail?: string | null): boolean {
  const { LIVE_MEDIATION_ENABLED, LIVE_MEDIATION_ALLOWED_EMAILS } = getEnv()

  if (LIVE_MEDIATION_ENABLED) return true

  if (!userEmail) return false

  const allowlist = LIVE_MEDIATION_ALLOWED_EMAILS
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)

  return allowlist.includes(userEmail.toLowerCase())
}

/**
 * Meeting Mediation is enabled globally via MEETING_MEDIATION_ENABLED=true, or per-user
 * via a comma-separated MEETING_MEDIATION_ALLOWED_EMAILS allowlist (case-insensitive).
 * Independent of Live Mediation's flag — the two roll out on separate schedules.
 */
export function isMeetingMediationEnabled(userEmail?: string | null): boolean {
  const { MEETING_MEDIATION_ENABLED, MEETING_MEDIATION_ALLOWED_EMAILS } = getEnv()

  if (MEETING_MEDIATION_ENABLED) return true

  if (!userEmail) return false

  const allowlist = MEETING_MEDIATION_ALLOWED_EMAILS
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)

  return allowlist.includes(userEmail.toLowerCase())
}

/** Whether the Recall meeting-bot provider has real credentials configured (vs. dev/unconfigured). */
export function isRecallConfigured(): boolean {
  const { RECALL_API_KEY } = getEnv()
  return Boolean(RECALL_API_KEY)
}
