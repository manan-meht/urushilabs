/**
 * Server-only: who must agree to a conversation's settings.
 *
 * Each mode stores participants differently — `participants` for invited intake,
 * `room_participants`, `meeting_participants`, and Together which has no
 * per-person rows at all (just person_a/person_b names on the session). This
 * module is the one place that knows the difference, so the acceptance rules
 * themselves stay mode-agnostic.
 *
 * Shared-device sessions collapse to a single SHARED_DEVICE_REF: one
 * confirmation from whoever is holding the device, on behalf of everyone
 * present. That is a genuinely weaker signal than each person tapping their own
 * phone, and the UI says so rather than dressing it up as verified individual
 * consent.
 */

import { getServiceClient } from '@/lib/db/client'
import { SHARED_DEVICE_REF } from './acceptance'

/**
 * The refs expected to accept, for whichever mode this case is.
 *
 * Returns an empty list when nobody is outstanding — a private single-party
 * intake has no second person to agree with, so there is nothing to gate on.
 */
export async function expectedRefsForCase(caseId: string): Promise<string[]> {
  const db = getServiceClient()

  const { data: caseRow } = await db
    .from('cases')
    .select('conversation_mode')
    .eq('id', caseId)
    .maybeSingle()

  const mode = (caseRow?.conversation_mode ?? 'invited') as string

  switch (mode) {
    case 'room': {
      // Everyone is physically around one device, so there is exactly one
      // confirmation to collect rather than one per person.
      return [SHARED_DEVICE_REF]
    }

    case 'together': {
      const { data: session } = await db
        .from('together_sessions')
        .select('device_mode')
        .eq('case_id', caseId)
        .maybeSingle()

      // Shared device: one confirmation covers the pair. Separate devices: each
      // person answers on their own, so both must.
      return session?.device_mode === 'separate'
        ? ['person_a', 'person_b']
        : [SHARED_DEVICE_REF]
    }

    case 'meeting_mediation': {
      const { data: participants } = await db
        .from('meeting_participants')
        .select('id')
        .eq('case_id', caseId)

      return (participants ?? []).map((p) => p.id as string)
    }

    case 'invited':
    default: {
      // Only participants who have actually joined can be waited on — an
      // invitation that has not been accepted yet is not a pending acceptance,
      // it is a pending invitation, and blocking on it would stall the
      // initiator's own private intake.
      const { data: participants } = await db
        .from('participants')
        .select('id, invitation_accepted_at')
        .eq('case_id', caseId)

      return (participants ?? [])
        .filter((p) => p.invitation_accepted_at !== null)
        .map((p) => p.id as string)
    }
  }
}
