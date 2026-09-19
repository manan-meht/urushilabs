'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ConversationStyleFields,
  DEFAULT_CONVERSATION_STYLE_VALUE,
  type ConversationStyleValue,
} from './ConversationStyleFields'

interface Props {
  userFirstName: string
  roomsRemaining: number
  existingCases: Array<{ reference: string; topic: string }>
}

export function RoomSetupForm({ userFirstName, roomsRemaining, existingCases }: Props) {
  const router = useRouter()
  const [participantCount, setParticipantCount] = useState<2 | 3>(2)
  const [names, setNames] = useState<string[]>([userFirstName, ''])
  const [topic, setTopic] = useState('')
  const [contextSummary, setContextSummary] = useState('')
  const [sourceCaseReference, setSourceCaseReference] = useState('')
  const [style, setStyle] = useState<ConversationStyleValue>(DEFAULT_CONVERSATION_STYLE_VALUE)
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<Record<string, string[]>>({})
  const [serverError, setServerError] = useState('')
  const [noCredits, setNoCredits] = useState(false)

  function setParticipantCountAndResize(count: 2 | 3) {
    setParticipantCount(count)
    setNames((prev) => {
      const next = [...prev]
      while (next.length < count) next.push('')
      return next.slice(0, count)
    })
  }

  function updateName(index: number, value: string) {
    setNames((prev) => {
      const next = [...prev]
      next[index] = value
      return next
    })
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setErrors({})
    setServerError('')
    setNoCredits(false)

    try {
      const res = await fetch('/api/room/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participantNames: names.map((n) => n.trim()).filter(Boolean),
          topic,
          contextSummary: contextSummary || undefined,
          sourceCaseReference: sourceCaseReference || undefined,
          conversationSettings: {
            language: style.language,
            personality: style.personality,
            allowProfanity: style.allowProfanity,
            textScript: style.textScript,
          },
        }),
      })

      const data = await res.json() as { caseReference?: string; errors?: Record<string, string[]>; error?: string }

      if (!res.ok) {
        if (res.status === 402 || data.error === 'no_credits') {
          setNoCredits(true)
        } else if (data.errors) {
          setErrors(data.errors)
        } else {
          setServerError(data.error ?? 'An error occurred. Please try again.')
        }
        return
      }

      if (data.caseReference) {
        router.push(`/room/${data.caseReference}/consent`)
      }
    } catch {
      setServerError('A network error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="px-margin-mobile pb-stack-lg max-w-xl mx-auto">
      <div className="flex gap-3 p-4 bg-tertiary-container/20 rounded-xl border border-tertiary/20 mb-6 items-start">
        <span className="material-symbols-outlined text-tertiary shrink-0 text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>record_voice_over</span>
        <p className="text-label-sm text-on-surface-variant leading-snug">
          Everyone talks out loud, together, with this device in the middle. Urushi listens and steps in only when it helps.
        </p>
      </div>

      {/* Participant count */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        {([2, 3] as const).map((count) => (
          <button
            key={count}
            type="button"
            onClick={() => setParticipantCountAndResize(count)}
            className={`rounded-xl border-2 p-4 text-left transition-all ${
              participantCount === count
                ? 'border-tertiary bg-tertiary-container/20'
                : 'border-outline-variant bg-surface-container-lowest hover:border-tertiary/40'
            }`}
          >
            <p className={`font-label-md font-semibold ${participantCount === count ? 'text-tertiary' : 'text-on-surface'}`}>
              {count} people
            </p>
            <p className="font-label-sm text-on-surface-variant text-[12px] mt-0.5">
              {count === 2 ? 'Just the two of you' : 'You and two others'}
            </p>
          </button>
        ))}
      </div>

      {serverError && (
        <div className="bg-error-container text-on-error-container p-4 rounded-xl font-body-md mb-4" role="alert">
          {serverError}
        </div>
      )}

      {noCredits && (
        <div className="bg-surface-container-low border border-outline-variant rounded-xl p-5 flex flex-col gap-3 mb-4" role="alert">
          <p className="font-medium text-on-surface">You are out of credits.</p>
          <p className="text-label-sm text-on-surface-variant">Purchase a plan to start more conversations.</p>
        </div>
      )}

      <form className="space-y-gutter" onSubmit={handleSubmit} noValidate>
        <div className="space-y-stack-sm">
          <label className="block font-label-md text-on-surface-variant ml-1">Who&apos;s participating?</label>
          <div className="space-y-2">
            {names.map((name, i) => (
              <input
                key={i}
                type="text"
                required
                maxLength={80}
                value={name}
                onChange={(e) => updateName(i, e.target.value)}
                placeholder={`Person ${i + 1}${i === 2 ? ' (optional)' : ''} — first name`}
                className="w-full h-14 px-4 bg-white border border-outline-variant rounded-xl focus:border-tertiary focus:ring-1 focus:ring-tertiary outline-none transition-all placeholder:text-outline/50"
              />
            ))}
          </div>
          {errors['participantNames'] && (
            <p className="text-error text-label-md ml-1" role="alert">{errors['participantNames'][0]}</p>
          )}
        </div>

        <div className="space-y-stack-sm">
          <label htmlFor="topic" className="block font-label-md text-on-surface-variant ml-1">
            What would you like help resolving?
          </label>
          <input
            id="topic"
            type="text"
            required
            maxLength={120}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g., How we divide household responsibilities"
            className="w-full h-14 px-4 bg-white border border-outline-variant rounded-xl focus:border-tertiary focus:ring-1 focus:ring-tertiary outline-none transition-all placeholder:text-outline/50"
          />
          {errors['topic'] && (
            <p className="text-error text-label-md ml-1" role="alert">{errors['topic'][0]}</p>
          )}
        </div>

        {/* Voice-only: nothing is written, so no script to choose. */}
        <ConversationStyleFields value={style} onChange={setStyle} />

        {existingCases.length > 0 && (
          <div className="space-y-stack-sm">
            <label htmlFor="sourceCaseReference" className="block font-label-md text-on-surface-variant ml-1">
              Use context from an earlier conversation? <span className="text-outline font-normal">(optional)</span>
            </label>
            <select
              id="sourceCaseReference"
              value={sourceCaseReference}
              onChange={(e) => setSourceCaseReference(e.target.value)}
              className="w-full h-14 px-4 bg-white border border-outline-variant rounded-xl focus:border-tertiary focus:ring-1 focus:ring-tertiary outline-none transition-all text-on-surface appearance-none"
            >
              <option value="">Start fresh — no prior context</option>
              {existingCases.map((c) => (
                <option key={c.reference} value={c.reference}>{c.topic}</option>
              ))}
            </select>
          </div>
        )}

        <div className="space-y-stack-sm">
          <label htmlFor="contextSummary" className="block font-label-md text-on-surface-variant ml-1">
            Anything Urushi should know before you begin? <span className="text-outline font-normal">(optional)</span>
          </label>
          <textarea
            id="contextSummary"
            rows={3}
            maxLength={4000}
            value={contextSummary}
            onChange={(e) => setContextSummary(e.target.value)}
            placeholder="A little background helps Urushi understand the situation before the conversation starts."
            className="w-full px-4 py-3 bg-white border border-outline-variant rounded-xl focus:border-tertiary focus:ring-1 focus:ring-tertiary outline-none transition-all placeholder:text-outline/50 resize-none"
          />
        </div>

        <div className="pt-2 space-y-3">
          <button
            type="submit"
            disabled={loading}
            className="w-full h-14 bg-tertiary text-white rounded-xl font-bold text-body-md hover:opacity-90 transition-all active:scale-[0.98] shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Setting up your room…
              </span>
            ) : 'Continue'}
          </button>
          <p className="text-center text-label-sm text-on-surface-variant">Setup takes about a minute.</p>
        </div>

        {roomsRemaining > 0 && (
          <p className="text-center text-label-sm text-outline">
            {roomsRemaining} conversation room{roomsRemaining !== 1 ? 's' : ''} remaining
          </p>
        )}
      </form>
    </div>
  )
}
