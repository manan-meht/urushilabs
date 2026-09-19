/**
 * Who has agreed to the current conversation settings, and what that permits.
 *
 * Pure decision logic — no I/O — so the rules can be unit-tested directly. The
 * routes supply the acceptance rows; this module decides what they mean.
 *
 * Two rules do the real work:
 *
 *  1. Acceptance is tied to a settings VERSION. An agreement gathered under
 *     "Diplomat, no swearing" must not authorise "Straight Shooter, swearing on"
 *     — so changing a setting bumps the version and every prior acceptance stops
 *     counting for it.
 *
 *  2. Profanity is tracked separately from general acceptance. Agreeing to a
 *     style is not agreeing to be sworn at, so a participant who accepts the
 *     style while declining the swearing is recorded as exactly that, and the
 *     swearing stays off.
 */

import type { ConversationSettings } from './settings'

export interface SettingsAcceptance {
  participantRef: string
  settingsVersion: number
  acceptedProfanity: boolean
  declinedAt?: string | null
}

/**
 * A stable per-mode identifier for whoever is accepting.
 *
 * Shared-device sessions use SHARED_DEVICE_REF: one confirmation from the person
 * holding the device, on behalf of everyone physically present. That is a
 * genuinely weaker signal than each person tapping their own phone, and it is
 * deliberately not dressed up as individually verified consent — see
 * isSharedDeviceRef and the copy used at the confirmation point.
 */
export const SHARED_DEVICE_REF = 'shared_device'

export function isSharedDeviceRef(ref: string): boolean {
  return ref === SHARED_DEVICE_REF
}

export interface AcceptanceStatus {
  /** Every expected participant has accepted the current version. */
  allAccepted: boolean
  /** Refs still to respond. */
  pending: string[]
  /** Refs that actively said no — these need a revised proposal, not more waiting. */
  declined: string[]
  /**
   * Whether profanity may actually be used right now. Requires the setting to be
   * on AND every expected participant to have accepted it specifically.
   */
  profanityPermitted: boolean
}

/**
 * Evaluates acceptance of `settings` by `expectedRefs`.
 *
 * Acceptances for other versions are ignored rather than counted, which is the
 * whole point of versioning them.
 */
export function evaluateAcceptance(
  settings: ConversationSettings,
  expectedRefs: readonly string[],
  acceptances: readonly SettingsAcceptance[]
): AcceptanceStatus {
  const current = acceptances.filter((a) => a.settingsVersion === settings.version)
  const byRef = new Map(current.map((a) => [a.participantRef, a]))

  const declined: string[] = []
  const pending: string[] = []

  for (const ref of expectedRefs) {
    const row = byRef.get(ref)
    if (!row) {
      pending.push(ref)
    } else if (row.declinedAt) {
      declined.push(ref)
    }
  }

  const allAccepted = pending.length === 0 && declined.length === 0

  return {
    allAccepted,
    pending,
    declined,
    // Unanimous and explicit. One person declining the swearing turns it off for
    // the shared conversation rather than for themselves — there is only one
    // mediator and everybody hears it.
    profanityPermitted:
      settings.allowProfanity &&
      allAccepted &&
      expectedRefs.every((ref) => byRef.get(ref)?.acceptedProfanity === true),
  }
}

/**
 * The settings that should actually drive the AI, given who has agreed to what.
 *
 * Profanity is the only setting that degrades: if it is on but not unanimously
 * accepted, it is silently forced off rather than blocking the conversation.
 * Everything else waits for acceptance instead — see canStartConversation.
 */
export function effectiveSettings(
  settings: ConversationSettings,
  status: AcceptanceStatus
): ConversationSettings {
  if (settings.allowProfanity && !status.profanityPermitted) {
    return { ...settings, allowProfanity: false }
  }
  return settings
}

/**
 * Whether the conversation may begin under these settings.
 *
 * Profanity deliberately does not gate this: it degrades to off instead, so one
 * person declining the swearing does not stop the mediation everyone came for.
 */
export function canStartConversation(status: AcceptanceStatus): boolean {
  return status.allAccepted
}

/**
 * The settings that stay in force while a proposed change is still being
 * accepted.
 *
 * A proposal must never take effect early. Until everyone has agreed to the new
 * version, the conversation continues under the last one everybody actually
 * accepted — otherwise proposing a change would be a way to impose it.
 */
export function activeSettingsDuringProposal(
  accepted: ConversationSettings,
  proposed: ConversationSettings,
  proposedStatus: AcceptanceStatus
): ConversationSettings {
  return proposedStatus.allAccepted ? proposed : accepted
}

/**
 * Turning profanity OFF takes effect immediately for anyone who asks — it
 * withdraws a permission they previously granted, and nobody else's agreement is
 * needed to stop being sworn at. Turning it back ON requires everyone again.
 */
export function disableProfanity(settings: ConversationSettings): ConversationSettings {
  if (!settings.allowProfanity) return settings
  return { ...settings, allowProfanity: false, version: settings.version + 1 }
}

/**
 * Applies a proposed change, bumping the version so prior acceptances no longer
 * authorise it.
 *
 * Returns the settings unchanged, and the version un-bumped, when nothing
 * acceptance-relevant differs — otherwise merely reopening a settings panel
 * would invalidate everyone's agreement and stall the conversation.
 */
export function proposeSettingsChange(
  current: ConversationSettings,
  changes: Partial<Pick<ConversationSettings, 'language' | 'personality' | 'allowProfanity' | 'textScript'>>
): ConversationSettings {
  const next: ConversationSettings = {
    ...current,
    ...changes,
    // Kept in lockstep with the personality here as well as in the normalizer,
    // so a proposal can never carry a combination the product does not offer.
    allowProfanity:
      (changes.personality ?? current.personality) === 'straight_shooter'
        ? (changes.allowProfanity ?? current.allowProfanity)
        : false,
  }

  const acceptanceRelevantChange =
    next.language !== current.language ||
    next.personality !== current.personality ||
    next.allowProfanity !== current.allowProfanity

  return acceptanceRelevantChange ? { ...next, version: current.version + 1 } : next
}
