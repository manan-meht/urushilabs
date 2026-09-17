'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const CONSENT_ITEMS = [
  'I am participating voluntarily.',
  'I understand that Urushi is an AI mediator.',
  'I am comfortable with Urushi listening to this conversation.',
  'We will allow each other to speak without intimidation or threats.',
] as const

interface Props {
  sessionId: string
  caseReference: string
  participantNames: string[]
  topic: string
}

export function RoomConsentChecklist({ sessionId, caseReference, participantNames, topic }: Props) {
  const router = useRouter()
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const allChecked = checked.size === CONSENT_ITEMS.length

  function toggle(i: number) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i); else next.add(i)
      return next
    })
  }

  async function handleBegin() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/room/sessions/${sessionId}/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmedVoluntary: true,
          confirmedAiMediator: true,
          confirmedComfortableListening: true,
          confirmedNoIntimidation: true,
        }),
      })
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        setError(data.error ?? 'Failed to record consent.')
        return
      }
      router.push(`/room/${caseReference}/ready`)
    } catch {
      setError('A network error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="px-margin-mobile pt-stack-md pb-stack-lg max-w-lg mx-auto">
      <div className="text-center mb-stack-md">
        <div className="w-16 h-16 bg-tertiary-container rounded-full flex items-center justify-center mx-auto mb-4">
          <span className="material-symbols-outlined text-white text-[32px]" style={{ fontVariationSettings: "'FILL' 1" }}>record_voice_over</span>
        </div>
        <h1 className="font-headline-xl-mobile text-headline-xl-mobile text-on-surface mb-2">Before you begin</h1>
        <p className="font-body-md text-on-surface-variant">
          <strong>{participantNames.join(', ')}</strong> — everyone in the room should read and agree to the following.
        </p>
      </div>

      <div className="bg-surface-container-low rounded-xl p-4 mb-6 border border-outline-variant/40">
        <p className="font-label-sm text-outline uppercase tracking-widest mb-1">Topic</p>
        <p className="font-body-md text-on-surface">{topic}</p>
      </div>

      <div className="space-y-3 mb-6">
        {CONSENT_ITEMS.map((item, i) => (
          <label
            key={i}
            className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition-all ${
              checked.has(i)
                ? 'bg-tertiary-container/20 border-tertiary/40'
                : 'bg-surface-container-lowest border-outline-variant hover:border-tertiary/30'
            }`}
          >
            <input
              type="checkbox"
              checked={checked.has(i)}
              onChange={() => toggle(i)}
              className="mt-0.5 w-5 h-5 rounded accent-[#386664] shrink-0"
              aria-label={item}
            />
            <span className="font-body-md text-on-surface leading-snug">{item}</span>
          </label>
        ))}
      </div>

      <div className="mb-6 p-4 bg-surface-container-low rounded-xl border border-outline-variant/40">
        <p className="font-label-sm text-on-surface-variant leading-snug">
          If anyone feels physically unsafe, this isn&apos;t the right tool right now. Urushi cannot assess whether a
          relationship is safe. See our <a href="/safety" className="text-secondary underline">safety page</a> for
          support options, including emergency services.
        </p>
      </div>

      {error && (
        <div className="bg-error-container text-on-error-container p-4 rounded-xl font-body-md mb-4" role="alert">
          {error}
        </div>
      )}

      <button
        onClick={() => void handleBegin()}
        disabled={!allChecked || loading}
        className="w-full h-14 bg-tertiary text-white rounded-xl font-bold text-body-md hover:opacity-90 transition-all active:scale-[0.98] shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
        aria-disabled={!allChecked}
      >
        {loading ? 'Continuing…' : 'Continue'}
      </button>

      {!allChecked && (
        <p className="text-center text-label-sm text-outline mt-2">
          Everyone must confirm all four items before continuing.
        </p>
      )}
    </div>
  )
}
