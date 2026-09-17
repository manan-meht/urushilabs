/**
 * Live Mediation analytics + usage logging. Follows the only existing analytics
 * pattern in this codebase: writing structured rows to `audit_events`
 * (case_id, event_type, metadata) — there is no third-party analytics SDK, and the
 * privacy page explicitly states none is used. This keeps that true while still
 * giving us queryable event/usage data for later pricing and rollout decisions.
 */

import type { getServiceClient } from '@/lib/db/client'

type ServiceClient = ReturnType<typeof getServiceClient>

export const ROOM_ANALYTICS_EVENTS = {
  SELECTED: 'live_mediation_selected',
  SETUP_STARTED: 'live_mediation_setup_started',
  STARTED: 'live_mediation_started',
  MIC_PERMISSION_GRANTED: 'microphone_permission_granted',
  MIC_PERMISSION_DENIED: 'microphone_permission_denied',
  INTERVENTION: 'live_mediation_intervention',
  PAUSED: 'live_mediation_paused',
  RESUMED: 'live_mediation_resumed',
  COMPLETED: 'live_mediation_completed',
  ABANDONED: 'live_mediation_abandoned',
  CONNECTION_ERROR: 'live_mediation_connection_error',
} as const

export type RoomAnalyticsEventName = typeof ROOM_ANALYTICS_EVENTS[keyof typeof ROOM_ANALYTICS_EVENTS]

/**
 * Fire-and-forget-friendly event/usage logger. Never throws — a failed analytics
 * write should never break the mediation flow. Internal-only metadata (token counts,
 * durations, etc.) is fine here; none of this is surfaced to end users.
 */
export async function trackRoomEvent(
  db: ServiceClient,
  opts: { caseId: string; event: RoomAnalyticsEventName | string; metadata?: Record<string, unknown> }
): Promise<void> {
  const { error } = await db.from('audit_events').insert({
    case_id: opts.caseId,
    event_type: opts.event,
    metadata: opts.metadata ?? null,
  })
  if (error) console.error('[trackRoomEvent] failed to log event:', opts.event, error.message)
}
