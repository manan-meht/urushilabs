'use client'

/**
 * The "What kind of language?" expander next to the strong-profanity toggle.
 *
 * Exists because the toggle's one-line helper cannot convey what is actually
 * being permitted, and this setting permits real adult profanity — including
 * conventionally family-based Hindi expressions used idiomatically. Agreeing to
 * that and only discovering the intensity mid-mediation would be a bad surprise
 * in a conversation that is already difficult.
 *
 * Shows the forbidden examples too. The boundary is the reassuring part: seeing
 * a rejected line makes "never aimed at you" concrete in a way the phrase alone
 * does not.
 */

import { useState } from 'react'
import {
  PROFANITY_FORBIDDEN_EXAMPLES,
  PROFANITY_PERMITTED_EXAMPLES,
  PROFANITY_REASSURANCE,
} from '@/lib/conversation/profanityExamples'

export function ProfanityDisclosure() {
  const [open, setOpen] = useState(false)

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 font-label-sm text-primary hover:underline focus:outline-none focus:underline"
      >
        <span className="material-symbols-outlined text-[16px]">{open ? 'expand_less' : 'help'}</span>
        What kind of language?
      </button>

      {open && (
        <div className="mt-2 rounded-xl border border-outline-variant bg-surface-container-lowest p-4 space-y-4">
          <div>
            <p className="font-label-sm text-outline uppercase tracking-widest mb-2">Urushi might say</p>
            <ul className="space-y-2">
              {PROFANITY_PERMITTED_EXAMPLES.map((ex) => (
                <li key={ex.text}>
                  <p className="font-body-md text-on-surface italic leading-snug">&ldquo;{ex.text}&rdquo;</p>
                  <p className="font-label-sm text-on-surface-variant text-[12px] leading-snug">{ex.note}</p>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="font-label-sm text-outline uppercase tracking-widest mb-2">Urushi will never say</p>
            <ul className="space-y-2">
              {PROFANITY_FORBIDDEN_EXAMPLES.map((ex) => (
                <li key={ex.text}>
                  <p className="font-body-md text-on-surface-variant italic leading-snug line-through decoration-outline/60">
                    &ldquo;{ex.text}&rdquo;
                  </p>
                  <p className="font-label-sm text-on-surface-variant text-[12px] leading-snug">{ex.note}</p>
                </li>
              ))}
            </ul>
          </div>

          <p className="font-label-sm text-on-surface-variant text-[12px] leading-snug">{PROFANITY_REASSURANCE}</p>
        </div>
      )}
    </div>
  )
}
