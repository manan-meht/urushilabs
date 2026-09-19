'use client'

/**
 * Language + mediator personality + profanity controls, shared by every setup
 * form (invited, together, room, meeting).
 *
 * One component rather than four copies: these settings mean the same thing in
 * every mode, and a per-mode copy is how the wording and the defaults drift
 * apart.
 *
 * Kept deliberately compact. The setup screens already ask for names, a topic
 * and mode-specific options, and three full-height personality cards plus a
 * language row plus a toggle would dominate the page — so the whole block
 * collapses to a one-line summary once a choice is made, and the preview is
 * opt-in rather than always rendered.
 */

import { useId, useRef, useState } from 'react'
import {
  CONVERSATION_LANGUAGE_LABELS,
  CONVERSATION_LANGUAGES,
  MEDIATOR_PERSONALITIES,
  MEDIATOR_PERSONALITY_DESCRIPTIONS,
  MEDIATOR_PERSONALITY_ICONS,
  MEDIATOR_PERSONALITY_LABELS,
  TEXT_SCRIPT_LABELS,
  TEXT_SCRIPTS,
  defaultScriptForLanguage,
  scriptIsRelevant,
  type ConversationLanguage,
  type MediatorPersonality,
  type TextScript,
} from '@/lib/conversation/settings'
import { getStylePreview, PREVIEW_SCENARIO } from '@/lib/conversation/previews'

export interface ConversationStyleValue {
  language: ConversationLanguage
  personality: MediatorPersonality
  allowProfanity: boolean
  textScript: TextScript
}

export const DEFAULT_CONVERSATION_STYLE_VALUE: ConversationStyleValue = {
  language: 'english',
  personality: 'diplomat',
  allowProfanity: false,
  textScript: 'roman',
}

interface Props {
  value: ConversationStyleValue
  onChange: (next: ConversationStyleValue) => void
  /**
   * False for voice-only modes (live mediation, meeting mediation), where there
   * is no text for a script to apply to. Asking would be a meaningless question.
   */
  showScript?: boolean
  /** Starts expanded when the user has no saved preference to summarise. */
  defaultExpanded?: boolean
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="font-label-sm text-outline uppercase tracking-widest mb-2 ml-1">{children}</p>
}

export function ConversationStyleFields({ value, onChange, showScript = false, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [previewFor, setPreviewFor] = useState<MediatorPersonality | null>(null)
  const groupId = useId()
  const cardRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  function update(patch: Partial<ConversationStyleValue>) {
    const next = { ...value, ...patch }
    // Profanity is a Straight Shooter-only control. Switching away must clear it
    // in the form state too, not just hide it — otherwise the toggle reappears
    // still checked if the user switches back, implying a setting they never
    // re-made. The server enforces the same rule independently.
    if (next.personality !== 'straight_shooter') next.allowProfanity = false
    if (patch.language && !patch.textScript) next.textScript = defaultScriptForLanguage(patch.language)
    onChange(next)
  }

  /** Roving focus so the three cards behave like a real radio group. */
  function handleCardKeyDown(e: React.KeyboardEvent, index: number) {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']
    if (!keys.includes(e.key)) return
    e.preventDefault()
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1
    const nextIndex = (index + delta + MEDIATOR_PERSONALITIES.length) % MEDIATOR_PERSONALITIES.length
    const nextPersonality = MEDIATOR_PERSONALITIES[nextIndex]!
    update({ personality: nextPersonality })
    cardRefs.current[nextPersonality]?.focus()
  }

  const summary = [
    CONVERSATION_LANGUAGE_LABELS[value.language],
    MEDIATOR_PERSONALITY_LABELS[value.personality],
    value.allowProfanity ? 'strong language on' : null,
  ].filter(Boolean).join(' · ')

  if (!expanded) {
    return (
      <div className="mb-6">
        <SectionLabel>Language &amp; style</SectionLabel>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full flex items-center gap-3 rounded-xl border-2 border-outline-variant bg-surface-container-lowest p-4 text-left transition-all hover:border-primary/40 focus:outline-none focus:border-primary"
        >
          <span className="material-symbols-outlined text-[20px] text-outline" style={{ fontVariationSettings: "'FILL' 1" }}>
            {MEDIATOR_PERSONALITY_ICONS[value.personality]}
          </span>
          <span className="flex-1 font-body-md text-on-surface">{summary}</span>
          <span className="font-label-sm text-primary">Change</span>
        </button>
      </div>
    )
  }

  return (
    <div className="mb-6">
      <SectionLabel>Language</SectionLabel>
      <div className="flex flex-wrap gap-2 mb-5" role="radiogroup" aria-label="Conversation language">
        {CONVERSATION_LANGUAGES.map((lang) => {
          const active = value.language === lang
          return (
            <button
              key={lang}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => update({ language: lang })}
              className={`px-4 h-11 rounded-full border-2 font-label-md transition-all focus:outline-none focus:ring-2 focus:ring-primary/40 ${
                active
                  ? 'border-primary bg-primary-container/30 text-primary font-semibold'
                  : 'border-outline-variant bg-surface-container-lowest text-on-surface-variant hover:border-primary/40'
              }`}
            >
              {CONVERSATION_LANGUAGE_LABELS[lang]}
            </button>
          )
        })}
      </div>

      {showScript && scriptIsRelevant(value.language) && (
        <div className="mb-5">
          <SectionLabel>Script</SectionLabel>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Text script">
            {TEXT_SCRIPTS.map((script) => {
              const active = value.textScript === script
              return (
                <button
                  key={script}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => update({ textScript: script })}
                  className={`px-4 h-10 rounded-full border-2 font-label-sm transition-all focus:outline-none focus:ring-2 focus:ring-primary/40 ${
                    active
                      ? 'border-primary bg-primary-container/30 text-primary font-semibold'
                      : 'border-outline-variant bg-surface-container-lowest text-on-surface-variant hover:border-primary/40'
                  }`}
                >
                  {TEXT_SCRIPT_LABELS[script]}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <SectionLabel>Conversation style</SectionLabel>
      <div
        className="grid grid-cols-1 sm:grid-cols-3 gap-3"
        role="radiogroup"
        aria-label="Conversation style"
        id={groupId}
      >
        {MEDIATOR_PERSONALITIES.map((personality, index) => {
          const active = value.personality === personality
          return (
            <button
              key={personality}
              ref={(el) => { cardRefs.current[personality] = el }}
              type="button"
              role="radio"
              aria-checked={active}
              // Only the selected card is in the tab order; arrows move between
              // them. Three separate tab stops for one choice is the classic way
              // to make a keyboard user's life miserable.
              tabIndex={active ? 0 : -1}
              onClick={() => update({ personality })}
              onKeyDown={(e) => handleCardKeyDown(e, index)}
              className={`rounded-xl border-2 p-4 text-left transition-all focus:outline-none focus:ring-2 focus:ring-primary/40 ${
                active
                  ? 'border-primary bg-primary-container/20'
                  : 'border-outline-variant bg-surface-container-lowest hover:border-primary/40'
              }`}
            >
              <span
                className={`material-symbols-outlined text-[24px] mb-2 block ${active ? 'text-primary' : 'text-outline'}`}
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                {MEDIATOR_PERSONALITY_ICONS[personality]}
              </span>
              <p className={`font-label-md font-semibold ${active ? 'text-primary' : 'text-on-surface'}`}>
                {MEDIATOR_PERSONALITY_LABELS[personality]}
              </p>
              <p className="font-label-sm text-on-surface-variant text-[12px] mt-0.5 leading-snug">
                {MEDIATOR_PERSONALITY_DESCRIPTIONS[personality]}
              </p>
            </button>
          )
        })}
      </div>

      <button
        type="button"
        onClick={() => setPreviewFor((p) => (p === value.personality ? null : value.personality))}
        aria-expanded={previewFor === value.personality}
        className="mt-3 flex items-center gap-1 font-label-sm text-primary hover:underline focus:outline-none focus:underline"
      >
        <span className="material-symbols-outlined text-[16px]">
          {previewFor === value.personality ? 'expand_less' : 'play_circle'}
        </span>
        {previewFor === value.personality ? 'Hide preview' : 'Preview this style'}
      </button>

      {previewFor === value.personality && (
        <div className="mt-2 rounded-xl border border-outline-variant bg-surface-container-lowest p-4">
          <p className="font-label-sm text-outline mb-2">{PREVIEW_SCENARIO[value.language]}</p>
          <p className="font-body-md text-on-surface italic leading-snug">
            &ldquo;{getStylePreview(value.personality, value.language, value.allowProfanity)}&rdquo;
          </p>
        </div>
      )}

      {value.personality === 'straight_shooter' && (
        <label className="mt-4 flex items-start gap-3 p-4 rounded-xl border border-outline-variant bg-surface-container-lowest cursor-pointer transition-all hover:border-primary/30">
          <input
            type="checkbox"
            checked={value.allowProfanity}
            onChange={(e) => update({ allowProfanity: e.target.checked })}
            className="mt-0.5 w-5 h-5 rounded accent-[#4a654e] shrink-0"
          />
          <span>
            <span className="font-body-md text-on-surface block">Allow occasional swearing</span>
            <span className="font-label-sm text-on-surface-variant text-[12px] leading-snug">
              Urushi may use strong language for emphasis. No personal abuse.
            </span>
          </span>
        </label>
      )}

      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="mt-4 font-label-sm text-on-surface-variant hover:text-on-surface focus:outline-none focus:underline"
      >
        Done
      </button>
    </div>
  )
}
