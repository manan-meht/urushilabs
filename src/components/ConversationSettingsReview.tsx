'use client'

/**
 * Presentational: shows what Urushi has been configured to be, plus the optional
 * separate answer about swearing.
 *
 * Split out of ConversationSettingsAgreement so the two shapes of consent can
 * share one description of what is being agreed to:
 *
 *  - Per-person (ConversationSettingsAgreement): its own accept/decline buttons,
 *    posted individually — used where each participant answers on their own
 *    device.
 *  - Shared-device (room, together-on-one-phone): embedded in that mode's
 *    existing consent screen and confirmed with everything else in one tap,
 *    because making a room of people work through a second full-screen step
 *    about mediator style is how you teach them to stop reading.
 *
 * The profanity checkbox is controlled by the parent precisely so the
 * shared-device flow can submit it alongside its own consent payload.
 */

import { useState } from 'react'
import {
  CONVERSATION_LANGUAGE_LABELS,
  MEDIATOR_PERSONALITY_DESCRIPTIONS,
  MEDIATOR_PERSONALITY_ICONS,
  MEDIATOR_PERSONALITY_LABELS,
  type ConversationSettings,
} from '@/lib/conversation/settings'
import { getStylePreview, PREVIEW_SCENARIO } from '@/lib/conversation/previews'

interface Props {
  settings: ConversationSettings
  /** True when one person is confirming for everyone physically present. */
  sharedDevice?: boolean
  /**
   * Controlled state for the separate swearing answer. Omit both to render the
   * settings read-only — used where profanity is off and there is nothing extra
   * to agree to.
   */
  acceptProfanity?: boolean
  onAcceptProfanityChange?: (next: boolean) => void
}

export function ConversationSettingsReview({
  settings,
  sharedDevice = false,
  acceptProfanity,
  onAcceptProfanityChange,
}: Props) {
  const [showPreview, setShowPreview] = useState(false)

  return (
    <div>
      <dl className="space-y-3 mb-3">
        <div className="flex items-start gap-3">
          <span className="material-symbols-outlined text-[20px] text-outline mt-0.5">translate</span>
          <div>
            <dt className="font-label-sm text-outline uppercase tracking-widest">Language</dt>
            <dd className="font-body-md text-on-surface">{CONVERSATION_LANGUAGE_LABELS[settings.language]}</dd>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <span
            className="material-symbols-outlined text-[20px] text-outline mt-0.5"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            {MEDIATOR_PERSONALITY_ICONS[settings.personality]}
          </span>
          <div>
            <dt className="font-label-sm text-outline uppercase tracking-widest">Style</dt>
            <dd className="font-body-md text-on-surface">{MEDIATOR_PERSONALITY_LABELS[settings.personality]}</dd>
            <dd className="font-label-sm text-on-surface-variant text-[12px] leading-snug mt-0.5">
              {MEDIATOR_PERSONALITY_DESCRIPTIONS[settings.personality]}
            </dd>
          </div>
        </div>
      </dl>

      <button
        type="button"
        onClick={() => setShowPreview((v) => !v)}
        aria-expanded={showPreview}
        className="flex items-center gap-1 font-label-sm text-primary hover:underline focus:outline-none focus:underline"
      >
        <span className="material-symbols-outlined text-[16px]">{showPreview ? 'expand_less' : 'play_circle'}</span>
        {showPreview ? 'Hide example' : 'See an example'}
      </button>

      {showPreview && (
        <div className="mt-2 rounded-xl border border-outline-variant bg-surface-container-lowest p-4">
          <p className="font-label-sm text-outline mb-2">{PREVIEW_SCENARIO[settings.language]}</p>
          <p className="font-body-md text-on-surface italic leading-snug">
            &ldquo;{getStylePreview(settings.personality, settings.language, settings.allowProfanity)}&rdquo;
          </p>
        </div>
      )}

      {settings.allowProfanity && onAcceptProfanityChange && (
        <label className="mt-4 flex items-start gap-3 p-4 rounded-xl border border-outline-variant bg-surface-container-lowest cursor-pointer transition-all hover:border-primary/30">
          <input
            type="checkbox"
            checked={acceptProfanity === true}
            onChange={(e) => onAcceptProfanityChange(e.target.checked)}
            className="mt-0.5 w-5 h-5 rounded accent-[#4a654e] shrink-0"
          />
          <span>
            <span className="font-body-md text-on-surface block">
              {sharedDevice ? 'Everyone here agrees to strong language' : 'I agree to strong language'}
            </span>
            <span className="font-label-sm text-on-surface-variant text-[12px] leading-snug">
              Urushi may swear for emphasis. No personal abuse. This is optional — you can continue without it, and it
              stays off unless everyone agrees.
            </span>
          </span>
        </label>
      )}
    </div>
  )
}
