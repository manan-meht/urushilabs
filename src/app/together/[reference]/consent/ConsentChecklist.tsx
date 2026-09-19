'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ConversationSettingsReview } from '@/components/ConversationSettingsReview'
import type { ConversationSettings } from '@/lib/conversation/settings'

const CONSENT_ITEMS = [
  'We are both choosing to participate.',
  'We will let each other speak freely so Urushi can understand the situation.',
  'We will take turns and avoid interrupting each other.',
  "We are willing to listen to the other person's perspective, even if we disagree.",
  'We will focus on resolving the issue rather than attacking each other.',
] as const

const SAFETY_ITEM = 'Neither person feels physically unsafe participating in this conversation.' as const

interface Props {
  caseId: string
  settings: ConversationSettings
  /** One phone between them, so a single confirmation covers both. */
  sharedDevice: boolean
  sessionId: string
  caseReference: string
  personAName: string
  personBName: string
  topic: string
}

export function ConsentChecklist({ caseId, settings, sharedDevice, sessionId, caseReference, personAName, personBName, topic }: Props) {
  const router = useRouter()
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [acceptProfanity, setAcceptProfanity] = useState(false)
  const [safetyChecked, setSafetyChecked] = useState(false)
  const [safetyDeclined, setSafetyDeclined] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const allChecked = checked.size === CONSENT_ITEMS.length && safetyChecked

  function toggle(i: number) {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i); else next.add(i)
      return next
    })
  }

  function handleSafetyChange(e: React.ChangeEvent<HTMLInputElement>) {
    setSafetyChecked(e.target.checked)
    if (!e.target.checked) setSafetyDeclined(false)
  }

  function handleSafetyDeclineToggle() {
    setSafetyDeclined(d => !d)
    setSafetyChecked(false)
  }

  async function handleBegin() {
    setLoading(true)
    setError('')
    try {
      // Person A's acceptance. On one shared phone this covers both of them; on
      // separate devices person B answers for themselves when they join.
      const accepted = await fetch(`/api/conversation/${caseId}/settings/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settingsVersion: settings.version, acceptProfanity, decline: false }),
      })
      if (!accepted.ok) {
        setError('Could not record agreement to the conversation settings. Please try again.')
        return
      }

      const res = await fetch(`/api/together/sessions/${sessionId}/consent`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        setError(data.error ?? 'Failed to record consent.')
        return
      }
      router.push(`/together/${caseReference}/session`)
    } catch {
      setError('A network error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="px-margin-mobile pt-stack-md pb-stack-lg max-w-lg mx-auto">

      {/* Header */}
      <div className="text-center mb-stack-md">
        <div className="w-16 h-16 bg-secondary-container rounded-full flex items-center justify-center mx-auto mb-4">
          <span className="material-symbols-outlined text-white text-[32px]" style={{ fontVariationSettings: "'FILL' 1" }}>handshake</span>
        </div>
        <h1 className="font-headline-xl-mobile text-headline-xl-mobile text-on-surface mb-2">Before you begin</h1>
        <p className="font-body-md text-on-surface-variant">
          <strong>{personAName}</strong> and <strong>{personBName}</strong> — both of you need to confirm the following before starting.
        </p>
      </div>

      {/* Topic reminder */}
      <div className="bg-surface-container-low rounded-xl p-4 mb-6 border border-outline-variant/40">
        <p className="font-label-sm text-outline uppercase tracking-widest mb-1">Topic</p>
        <p className="font-body-md text-on-surface">{topic}</p>
      </div>

      {/* Consent items */}
      <div className="bg-surface-container-low rounded-xl p-4 mb-6 border border-outline-variant/40">
        <p className="font-label-sm text-outline uppercase tracking-widest mb-2">How Urushi will mediate</p>
        <ConversationSettingsReview
          settings={settings}
          sharedDevice={sharedDevice}
          acceptProfanity={acceptProfanity}
          onAcceptProfanityChange={setAcceptProfanity}
        />
      </div>

      <div className="space-y-3 mb-6">
        {CONSENT_ITEMS.map((item, i) => (
          <label
            key={i}
            className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition-all ${
              checked.has(i)
                ? 'bg-primary-container/20 border-primary/40'
                : 'bg-surface-container-lowest border-outline-variant hover:border-primary/30'
            }`}
          >
            <input
              type="checkbox"
              checked={checked.has(i)}
              onChange={() => toggle(i)}
              className="mt-0.5 w-5 h-5 rounded accent-[#4a654e] shrink-0"
              aria-label={item}
            />
            <span className="font-body-md text-on-surface leading-snug">{item}</span>
          </label>
        ))}

        {/* Safety item — special handling */}
        <label
          className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition-all ${
            safetyChecked
              ? 'bg-primary-container/20 border-primary/40'
              : 'bg-surface-container-lowest border-outline-variant hover:border-primary/30'
          }`}
        >
          <input
            type="checkbox"
            checked={safetyChecked}
            onChange={handleSafetyChange}
            className="mt-0.5 w-5 h-5 rounded accent-[#4a654e] shrink-0"
            aria-label={SAFETY_ITEM}
          />
          <span className="font-body-md text-on-surface leading-snug">{SAFETY_ITEM}</span>
        </label>
      </div>

      {/* Safety decline path */}
      <div className="mb-6">
        <button
          type="button"
          onClick={handleSafetyDeclineToggle}
          className="text-label-sm text-on-surface-variant hover:text-secondary underline underline-offset-2 transition-colors"
        >
          {safetyDeclined ? 'Hide safety information' : 'Someone feels unsafe — what should we do?'}
        </button>

        {safetyDeclined && (
          <div className="mt-3 p-4 bg-error-container/20 border border-error-container rounded-xl space-y-2">
            <div className="flex items-start gap-2">
              <span className="material-symbols-outlined text-error text-[20px] shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>warning</span>
              <div>
                <p className="font-label-md text-on-surface font-semibold mb-1">Urushi is not designed for situations involving safety concerns.</p>
                <p className="font-body-md text-on-surface-variant text-sm leading-relaxed">
                  Urushi&apos;s joint conversation process works best when both people feel they are participating freely and safely. If either person feels unsafe, coerced or under pressure, this process may not be appropriate right now.
                </p>
                <p className="font-body-md text-on-surface-variant text-sm leading-relaxed mt-2">
                  Urushi is an AI communication tool. It cannot assess whether a relationship is safe or harmful. If you have concerns about your safety, please consider speaking to a trusted person, a professional support service, or — in an emergency — contacting emergency services.
                </p>
                <a href="/safety" className="text-label-sm text-secondary underline mt-2 inline-block">
                  Visit our safety page →
                </a>
              </div>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="bg-error-container text-on-error-container p-4 rounded-xl font-body-md mb-4" role="alert">
          {error}
        </div>
      )}

      {/* CTA */}
      <button
        onClick={() => void handleBegin()}
        disabled={!allChecked || loading}
        className="w-full h-14 bg-secondary text-white rounded-xl font-bold text-body-md hover:bg-on-secondary-fixed-variant transition-all active:scale-[0.98] shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
        aria-disabled={!allChecked}
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            Beginning conversation…
          </span>
        ) : 'Begin conversation'}
      </button>

      {!allChecked && (
        <p className="text-center text-label-sm text-outline mt-2">
          All boxes must be checked before you can begin.
        </p>
      )}
    </div>
  )
}
