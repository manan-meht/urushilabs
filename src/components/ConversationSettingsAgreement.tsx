'use client'

/**
 * Shows the proposed language, style and swearing setting, and collects one
 * participant's agreement.
 *
 * Rendered before someone enters a shared conversation, and again whenever a
 * setting changes mid-session. Shared across modes so the wording of what people
 * are agreeing to cannot drift between them.
 *
 * Two things this component is careful about:
 *
 *  - Accepting the style is not accepting the swearing. Those are two separate
 *    answers, because a single "I agree" that quietly enables profanity is
 *    exactly the dark pattern the feature is meant to avoid.
 *
 *  - Shared-device confirmation is described honestly. One person tapping for
 *    everyone in the room is not individually verified consent, and the copy
 *    says so rather than implying otherwise.
 */

import { useState } from 'react'
import type { ConversationSettings } from '@/lib/conversation/settings'
import { ConversationSettingsReview } from './ConversationSettingsReview'

interface Props {
  caseId: string
  settings: ConversationSettings
  /**
   * True when one person is confirming for everyone physically present, rather
   * than each participant answering on their own device.
   */
  sharedDevice?: boolean
  /** Names of everyone the confirmation covers — shared-device modes only. */
  presentNames?: string[]
  onAccepted?: (result: { profanityPermitted: boolean }) => void
  onDeclined?: () => void
}

export function ConversationSettingsAgreement({
  caseId,
  settings,
  sharedDevice = false,
  presentNames = [],
  onAccepted,
  onDeclined,
}: Props) {
  // Defaults to false: profanity is opted INTO, never out of.
  const [acceptProfanity, setAcceptProfanity] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function respond(decline: boolean) {
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch(`/api/conversation/${caseId}/settings/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settingsVersion: settings.version,
          acceptProfanity: decline ? false : acceptProfanity,
          decline,
        }),
      })

      if (res.status === 409) {
        // The settings changed while this was on screen. Re-presenting them is
        // the whole point of versioning the acceptance.
        setError('These settings just changed. Please refresh and review them again.')
        return
      }
      if (!res.ok) {
        setError('Could not record your response. Please try again.')
        return
      }

      const data = await res.json() as { acceptance?: { profanityPermitted?: boolean } }
      if (decline) onDeclined?.()
      else onAccepted?.({ profanityPermitted: data.acceptance?.profanityPermitted === true })
    } catch {
      setError('Could not record your response. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-2xl border-2 border-outline-variant bg-surface-container-lowest p-6">
      <p className="font-headline-sm text-on-surface mb-1">How this conversation will run</p>
      <p className="font-body-md text-on-surface-variant leading-snug mb-5">
        {sharedDevice
          ? 'Please check everyone here agrees before you continue.'
          : 'Urushi will mediate using these settings. They apply to everyone in the conversation.'}
      </p>

      <ConversationSettingsReview
        settings={settings}
        sharedDevice={sharedDevice}
        acceptProfanity={acceptProfanity}
        onAcceptProfanityChange={setAcceptProfanity}
      />

      {sharedDevice && presentNames.length > 0 && (
        <p className="font-label-sm text-on-surface-variant text-[12px] leading-snug mb-4">
          You are confirming on behalf of {presentNames.join(' and ')}, who are here with you. This is a shared
          confirmation, not a separate record of each person&apos;s consent.
        </p>
      )}

      {error && <p className="font-label-sm text-error mb-3">{error}</p>}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => respond(false)}
          disabled={submitting}
          className="px-5 h-11 rounded-full bg-primary text-white font-label-md font-semibold transition-all hover:opacity-90 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          {submitting ? 'Saving…' : sharedDevice ? 'Everyone agrees' : 'I agree'}
        </button>
        <button
          type="button"
          onClick={() => respond(true)}
          disabled={submitting}
          className="px-5 h-11 rounded-full border-2 border-outline-variant text-on-surface-variant font-label-md transition-all hover:border-outline disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          Suggest something different
        </button>
      </div>
    </div>
  )
}
