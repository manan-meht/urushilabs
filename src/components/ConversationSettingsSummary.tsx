'use client'

/**
 * The compact "who is mediating and how" strip shown during a live conversation.
 *
 * Small on purpose — it sits alongside the actual conversation and must not
 * compete with it. It exists so nobody has to remember what they agreed to, and
 * so turning swearing off is always one tap away.
 *
 * Asymmetry worth noting: turning profanity OFF happens immediately, for
 * anyone, with no agreement needed — it withdraws a permission, and making
 * someone negotiate to stop being sworn at would be perverse. Turning it back ON
 * goes through the full proposal flow and needs everyone again.
 */

import { useState } from 'react'
import {
  CONVERSATION_LANGUAGE_LABELS,
  MEDIATOR_PERSONALITY_ICONS,
  MEDIATOR_PERSONALITY_LABELS,
  type ConversationSettings,
} from '@/lib/conversation/settings'

interface Props {
  caseId: string
  settings: ConversationSettings
  /** True while a proposed change is still waiting on other participants. */
  awaitingAcceptance?: boolean
  onChanged?: (settings: ConversationSettings) => void
  /** Hidden for participants who cannot change settings (e.g. a read-only view). */
  canDisableProfanity?: boolean
}

export function ConversationSettingsSummary({
  caseId,
  settings,
  awaitingAcceptance = false,
  onChanged,
  canDisableProfanity = true,
}: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function disableProfanity() {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/conversation/${caseId}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowProfanity: false }),
      })
      if (!res.ok) {
        setError('Could not turn that off. Please try again.')
        return
      }
      const data = await res.json() as { effective?: ConversationSettings }
      if (data.effective) onChanged?.(data.effective)
    } catch {
      setError('Could not turn that off. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container-lowest px-4 py-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span
          className="material-symbols-outlined text-[18px] text-outline"
          style={{ fontVariationSettings: "'FILL' 1" }}
        >
          {MEDIATOR_PERSONALITY_ICONS[settings.personality]}
        </span>
        <span className="font-label-md text-on-surface">
          {MEDIATOR_PERSONALITY_LABELS[settings.personality]}
        </span>
        <span className="font-label-sm text-outline">·</span>
        <span className="font-label-md text-on-surface-variant">
          {CONVERSATION_LANGUAGE_LABELS[settings.language]}
        </span>

        {settings.allowProfanity && (
          <>
            <span className="font-label-sm text-outline">·</span>
            <span className="font-label-sm text-on-surface-variant">Strong language on</span>
            {canDisableProfanity && (
              <button
                type="button"
                onClick={disableProfanity}
                disabled={busy}
                className="font-label-sm text-primary hover:underline disabled:opacity-50 focus:outline-none focus:underline"
              >
                {busy ? 'Turning off…' : 'Turn off'}
              </button>
            )}
          </>
        )}
      </div>

      {awaitingAcceptance && (
        <p className="font-label-sm text-on-surface-variant text-[12px] mt-2 leading-snug">
          A change has been proposed and is waiting for everyone to agree. Until then, the settings above stay in
          effect.
        </p>
      )}

      {error && <p className="font-label-sm text-error mt-2">{error}</p>}
    </div>
  )
}
