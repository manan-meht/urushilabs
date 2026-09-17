'use client'

import { useState } from 'react'

interface Props {
  token: string
  participantName: string
  topic: string
  contextSummary: string | null
  alreadyConsented: boolean
  alreadySubmittedContext: boolean
}

const CONSENT_ITEMS = [
  'I understand that Urushi is an AI mediator.',
  'I understand this meeting may be transcribed and processed by Urushi for mediation, and that Urushi may speak during the meeting.',
  'I am participating voluntarily.',
] as const

export function MeetingPrepareView({ token, participantName, topic, contextSummary, alreadyConsented, alreadySubmittedContext }: Props) {
  const [checked, setChecked] = useState<Set<number>>(new Set(alreadyConsented ? [0, 1, 2] : []))
  const [consented, setConsented] = useState(alreadyConsented)
  const [perspective, setPerspective] = useState('')
  const [contextSubmitted, setContextSubmitted] = useState(alreadySubmittedContext)
  const [loadingConsent, setLoadingConsent] = useState(false)
  const [loadingContext, setLoadingContext] = useState(false)
  const [error, setError] = useState('')

  const allChecked = checked.size === CONSENT_ITEMS.length

  function toggle(i: number) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i); else next.add(i)
      return next
    })
  }

  async function submitConsent() {
    setLoadingConsent(true)
    setError('')
    try {
      const res = await fetch(`/api/meeting/participants/token/${token}/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmedAiMediator: true,
          confirmedListeningAndProcessing: true,
          confirmedMaySpeak: true,
          confirmedVoluntary: true,
        }),
      })
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        setError(data.error ?? 'Failed to record consent.')
        return
      }
      setConsented(true)
    } catch {
      setError('A network error occurred. Please try again.')
    } finally {
      setLoadingConsent(false)
    }
  }

  async function submitContext() {
    if (!perspective.trim()) return
    setLoadingContext(true)
    setError('')
    try {
      const res = await fetch(`/api/meeting/participants/token/${token}/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ perspective }),
      })
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        setError(data.error ?? 'Failed to save your perspective.')
        return
      }
      setContextSubmitted(true)
    } catch {
      setError('A network error occurred. Please try again.')
    } finally {
      setLoadingContext(false)
    }
  }

  return (
    <div className="px-margin-mobile pt-stack-md pb-stack-lg max-w-lg mx-auto">
      <div className="text-center mb-stack-md">
        <div className="w-16 h-16 bg-primary-container rounded-full flex items-center justify-center mx-auto mb-4">
          <span className="material-symbols-outlined text-white text-[32px]" style={{ fontVariationSettings: "'FILL' 1" }}>video_call</span>
        </div>
        <h1 className="font-headline-xl-mobile text-headline-xl-mobile text-on-surface mb-2">Hi {participantName}</h1>
        <p className="font-body-md text-on-surface-variant">You&apos;ve been invited to a Meeting Mediation with Urushi.</p>
      </div>

      <div className="bg-surface-container-low rounded-xl p-4 mb-6 border border-outline-variant/40">
        <p className="font-label-sm text-outline uppercase tracking-widest mb-1">Topic</p>
        <p className="font-body-md text-on-surface">{topic}</p>
        {contextSummary && (
          <>
            <p className="font-label-sm text-outline uppercase tracking-widest mt-3 mb-1">Shared context</p>
            <p className="font-body-md text-on-surface">{contextSummary}</p>
          </>
        )}
      </div>

      {error && (
        <div className="bg-error-container text-on-error-container p-4 rounded-xl font-body-md mb-4" role="alert">{error}</div>
      )}

      {!consented ? (
        <section>
          <p className="font-label-md text-on-surface-variant mb-3">Before you continue</p>
          <div className="space-y-3 mb-6">
            {CONSENT_ITEMS.map((item, i) => (
              <label
                key={i}
                className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition-all ${
                  checked.has(i) ? 'bg-primary-container/20 border-primary/40' : 'bg-surface-container-lowest border-outline-variant hover:border-primary/30'
                }`}
              >
                <input type="checkbox" checked={checked.has(i)} onChange={() => toggle(i)} className="mt-0.5 w-5 h-5 rounded accent-primary shrink-0" aria-label={item} />
                <span className="font-body-md text-on-surface leading-snug">{item}</span>
              </label>
            ))}
          </div>
          <button
            onClick={() => void submitConsent()}
            disabled={!allChecked || loadingConsent}
            className="w-full h-14 bg-primary text-on-primary rounded-xl font-bold text-body-md hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loadingConsent ? 'Continuing…' : 'Continue'}
          </button>
        </section>
      ) : contextSubmitted ? (
        <section className="text-center bg-surface-container-low rounded-xl border border-outline-variant/40 p-6">
          <span className="material-symbols-outlined text-primary text-[32px] mb-2" style={{ fontVariationSettings: "'FILL' 1" }}>task_alt</span>
          <p className="font-headline-sm text-on-surface mb-1">You&apos;re all set</p>
          <p className="font-body-md text-on-surface-variant">We&apos;ll let you know when the meeting is ready.</p>
        </section>
      ) : (
        <section>
          <label htmlFor="perspective" className="block font-label-md text-on-surface-variant mb-2">
            Anything you&apos;d like Urushi to understand before the meeting?
          </label>
          <p className="font-label-sm text-on-surface-variant mb-3">
            This is private — it won&apos;t be shown to the other participants verbatim. Urushi may use it to understand the situation, but will always reframe it neutrally.
          </p>
          <textarea
            id="perspective"
            rows={6}
            maxLength={8000}
            value={perspective}
            onChange={(e) => setPerspective(e.target.value)}
            placeholder="Share your perspective on the situation…"
            className="w-full px-4 py-3 bg-white border border-outline-variant rounded-xl focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-all placeholder:text-outline/50 resize-none mb-4"
          />
          <button
            onClick={() => void submitContext()}
            disabled={!perspective.trim() || loadingContext}
            className="w-full h-14 bg-primary text-on-primary rounded-xl font-bold text-body-md hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loadingContext ? 'Saving…' : 'Submit'}
          </button>
        </section>
      )}
    </div>
  )
}
