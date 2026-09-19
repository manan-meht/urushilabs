'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { RELATIONSHIP_LABELS, RELATIONSHIP_OPTIONS } from '@/lib/validation/schemas'
import {
  ConversationStyleFields,
  DEFAULT_CONVERSATION_STYLE_VALUE,
  type ConversationStyleValue,
} from './ConversationStyleFields'

interface Props {
  userFirstName: string
  userEmail: string | null
  roomsRemaining: number
}

const TOPIC_EXAMPLES = [
  'Dividing responsibilities at home',
  'How we make business decisions',
  'A disagreement about money',
]

export function StartConversationForm({ userFirstName, userEmail, roomsRemaining }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<Record<string, string[]>>({})
  const [serverError, setServerError] = useState('')
  const [noCredits, setNoCredits] = useState(false)
  const [topic, setTopic] = useState('')
  const [style, setStyle] = useState<ConversationStyleValue>(DEFAULT_CONVERSATION_STYLE_VALUE)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setErrors({})
    setServerError('')
    setNoCredits(false)

    const fd = new FormData(e.currentTarget)
    const body = {
      recipientName: fd.get('recipientName'),
      relationship: fd.get('relationship') || undefined,
      topic: fd.get('topic'),
      conversationSettings: {
        language: style.language,
        personality: style.personality,
        allowProfanity: style.allowProfanity,
        textScript: style.textScript,
      },
    }

    try {
      const res = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const data = await res.json() as {
        caseReference?: string
        inviteLink?: string
        errors?: Record<string, string[]>
        error?: string
      }

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
        if (data.inviteLink) sessionStorage.setItem('cg_invite_link', data.inviteLink)
        router.push(`/case/${data.caseReference}/intake`)
      }
    } catch {
      setServerError('A network error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="px-margin-mobile pb-stack-lg max-w-xl mx-auto">

      {/* Identity indicator */}
      <div className="flex items-center gap-2 mb-6 p-3 bg-surface-container-low rounded-xl border border-outline-variant/40">
        <span className="material-symbols-outlined text-primary text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>account_circle</span>
        <div>
          <p className="font-label-md text-on-surface">Starting as <strong>{userFirstName}</strong></p>
          {userEmail && <p className="text-label-sm text-on-surface-variant">{userEmail}</p>}
        </div>
        <Link href="/auth" className="ml-auto text-label-sm text-secondary hover:underline shrink-0">
          Change account
        </Link>
      </div>

      <form className="space-y-gutter" onSubmit={handleSubmit} noValidate>

        {noCredits && (
          <div className="bg-surface-container-low border border-outline-variant rounded-xl p-5 flex flex-col gap-3" role="alert">
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-primary text-[24px]" style={{ fontVariationSettings: "'FILL' 1" }}>account_balance_wallet</span>
              <div>
                <p className="font-medium text-on-surface">You are out of credits.</p>
                <p className="text-label-sm text-on-surface-variant">Purchase a plan to start more conversations.</p>
              </div>
            </div>
            <Link
              href="/pricing"
              className="w-full py-3 bg-primary text-on-primary rounded-xl font-bold text-label-md text-center block"
            >
              Buy credits →
            </Link>
          </div>
        )}

        {serverError && (
          <div className="bg-error-container text-on-error-container p-4 rounded-xl font-body-md" role="alert">
            {serverError}
          </div>
        )}

        {/* Who is this with */}
        <div className="space-y-stack-sm">
          <label htmlFor="recipientName" className="block font-label-md text-on-surface-variant ml-1">
            Who is this conversation with?
          </label>
          <input
            id="recipientName"
            name="recipientName"
            type="text"
            required
            maxLength={80}
            placeholder="e.g., Alex"
            className="w-full h-14 px-4 bg-white border border-outline-variant rounded-xl focus:border-secondary focus:ring-1 focus:ring-secondary outline-none transition-all placeholder:text-outline/50"
            aria-describedby={errors['recipientName'] ? 'recipientName-error' : undefined}
          />
          {errors['recipientName'] && (
            <p id="recipientName-error" className="text-error text-label-md ml-1" role="alert">{errors['recipientName'][0]}</p>
          )}
        </div>

        {/* Relationship (optional) */}
        <div className="space-y-stack-sm">
          <label htmlFor="relationship" className="block font-label-md text-on-surface-variant ml-1">
            How do you know each other? <span className="text-outline font-normal">(optional)</span>
          </label>
          <select
            id="relationship"
            name="relationship"
            defaultValue=""
            className="w-full h-14 px-4 bg-white border border-outline-variant rounded-xl focus:border-secondary focus:ring-1 focus:ring-secondary outline-none transition-all text-on-surface appearance-none"
          >
            <option value="" disabled>Select relationship</option>
            {RELATIONSHIP_OPTIONS.map((key) => (
              <option key={key} value={key}>{RELATIONSHIP_LABELS[key]}</option>
            ))}
          </select>
        </div>

        {/* Topic */}
        <div className="space-y-stack-sm">
          <label htmlFor="topic" className="block font-label-md text-on-surface-variant ml-1">
            What would you like help discussing?
          </label>
          <p className="text-label-sm text-on-surface-variant ml-1">Describe the subject, not who is at fault.</p>
          <input
            id="topic"
            name="topic"
            type="text"
            required
            maxLength={120}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g., How we make decisions about our business"
            className="w-full h-14 px-4 bg-white border border-outline-variant rounded-xl focus:border-secondary focus:ring-1 focus:ring-secondary outline-none transition-all placeholder:text-outline/50"
            aria-describedby="topic-examples topic-warning"
          />
          <div id="topic-examples" className="flex flex-wrap gap-2">
            {TOPIC_EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setTopic(example)}
                className="text-label-sm text-secondary border border-secondary/30 rounded-full px-3 py-1 hover:bg-secondary/5 transition-colors"
              >
                {example}
              </button>
            ))}
          </div>
          <p id="topic-warning" className="text-label-sm text-on-surface-variant leading-relaxed">
            Keep the title neutral. Do not include accusations, private details, or sensitive personal information — the other person will see it.
          </p>
          {errors['topic'] && (
            <p className="text-error text-label-md ml-1" role="alert">{errors['topic'][0]}</p>
          )}
        </div>

        {/* Script matters here: intake is answered in writing. */}
        <ConversationStyleFields value={style} onChange={setStyle} showScript />

        {/* Privacy note */}
        <div className="flex gap-3 p-4 bg-surface-container-low rounded-xl border border-outline-variant/40 items-start">
          <span className="material-symbols-outlined text-secondary shrink-0 text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>lock</span>
          <p className="text-label-sm text-on-surface-variant leading-snug">
            Your raw responses will not be shown to the other person. A neutral shared report is only generated after both of you have independently contributed.
          </p>
        </div>

        {/* Submit */}
        <div className="pt-2 space-y-3">
          <button
            type="submit"
            disabled={loading}
            className="w-full h-14 bg-primary text-white rounded-xl font-bold text-body-md hover:bg-on-primary-fixed-variant transition-all active:scale-[0.98] shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Setting up your private space…
              </span>
            ) : 'Start private intake'}
          </button>
          <p className="text-center text-label-sm text-on-surface-variant">Usually takes 3–5 minutes.</p>
        </div>

        {/* Rooms remaining */}
        {roomsRemaining > 0 && (
          <p className="text-center text-label-sm text-outline">
            {roomsRemaining} conversation room{roomsRemaining !== 1 ? 's' : ''} remaining
          </p>
        )}
      </form>
    </div>
  )
}
