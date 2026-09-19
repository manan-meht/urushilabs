'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { MeetingAgentSetup } from './MeetingAgentSetup'
import {
  ConversationStyleFields,
  DEFAULT_CONVERSATION_STYLE_VALUE,
  type ConversationStyleValue,
} from './ConversationStyleFields'
import {
  DEFAULT_MEETING_ONLY_AGENT_SETTINGS,
  type MeetingOnlyAgentSettings,
} from '@/lib/meeting/agentSettings'
import {
  CONVERSATION_LANGUAGE_LABELS,
  MEDIATOR_PERSONALITY_LABELS,
} from '@/lib/conversation/settings'

interface ParticipantField {
  name: string
  email: string
}

const INTERVENTION_LABEL: Record<MeetingOnlyAgentSettings['interventionLevel'], string> = {
  observer: 'Observer',
  facilitator: 'Facilitator',
  chair: 'Chair the meeting',
}

const REGION_LABEL: Record<MeetingOnlyAgentSettings['region'], string> = {
  american: 'American',
  singaporean: 'Singaporean',
  indian: 'Indian',
}

interface Props {
  userFirstName: string
  userEmail: string | null
  roomsRemaining: number
}

export function MeetingSetupForm({ userFirstName, userEmail, roomsRemaining }: Props) {
  const router = useRouter()
  const [step, setStep] = useState<'details' | 'agent' | 'review'>('details')
  // Voice, accent and intervention frequency only. Personality, language and
  // profanity live in `style` below — one answer, one place.
  const [agentSettings, setAgentSettings] = useState<MeetingOnlyAgentSettings>(DEFAULT_MEETING_ONLY_AGENT_SETTINGS)
  const [participantCount, setParticipantCount] = useState<2 | 3>(2)
  const [participants, setParticipants] = useState<ParticipantField[]>([
    { name: userFirstName, email: userEmail ?? '' },
    { name: '', email: '' },
  ])
  const [topic, setTopic] = useState('')
  const [contextSummary, setContextSummary] = useState('')
  const [style, setStyle] = useState<ConversationStyleValue>(DEFAULT_CONVERSATION_STYLE_VALUE)
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<Record<string, string[]>>({})
  const [serverError, setServerError] = useState('')
  const [noCredits, setNoCredits] = useState(false)

  function setParticipantCountAndResize(count: 2 | 3) {
    setParticipantCount(count)
    setParticipants((prev) => {
      const next = [...prev]
      while (next.length < count) next.push({ name: '', email: '' })
      return next.slice(0, count)
    })
  }

  function updateParticipant(index: number, field: 'name' | 'email', value: string) {
    setParticipants((prev) => {
      const next = [...prev]
      next[index] = { ...next[index]!, [field]: value }
      return next
    })
  }

  function goToAgentStep(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setErrors({})
    setServerError('')
    setStep('agent')
  }

  async function handleCreate() {
    setLoading(true)
    setErrors({})
    setServerError('')
    setNoCredits(false)

    try {
      const res = await fetch('/api/meeting/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participants: participants.map((p) => ({ name: p.name.trim(), email: p.email.trim() })),
          topic,
          contextSummary: contextSummary || undefined,
          agentSettings,
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
          setStep('details')
        } else {
          setServerError(data.error ?? 'An error occurred. Please try again.')
        }
        return
      }

      if (data.caseReference) {
        router.push(`/meeting/${data.caseReference}/status`)
      }
    } catch {
      setServerError('A network error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (step === 'agent') {
    return (
      <div className="px-margin-mobile pb-stack-lg max-w-xl mx-auto">
        <h1 className="font-headline-xl-mobile text-headline-xl-mobile text-on-surface mb-1 text-center">
          How should Urushi show up?
        </h1>
        <p className="text-center text-on-surface-variant font-body-md mb-6">
          Everyone in the meeting agrees Urushi can help run the conversation.
        </p>

        <MeetingAgentSetup settings={agentSettings} onChange={setAgentSettings} />

        <div className="space-y-3 pt-6">
          <button
            onClick={() => setStep('review')}
            className="w-full h-14 bg-primary text-on-primary rounded-xl font-bold text-body-md hover:opacity-90 transition-all active:scale-[0.98] shadow-sm"
          >
            Continue
          </button>
          <button
            onClick={() => setStep('details')}
            className="w-full h-12 text-on-surface-variant font-label-md hover:text-on-surface transition-colors"
          >
            Back
          </button>
        </div>
      </div>
    )
  }

  if (step === 'review') {
    return (
      <div className="px-margin-mobile pb-stack-lg max-w-xl mx-auto">
        <h1 className="font-headline-xl-mobile text-headline-xl-mobile text-on-surface mb-1 text-center">
          Your Urushi mediation
        </h1>
        <p className="text-center text-on-surface-variant font-body-md mb-6">Review before Urushi prepares for the meeting.</p>

        {serverError && (
          <div className="bg-error-container text-on-error-container p-4 rounded-xl font-body-md mb-4" role="alert">{serverError}</div>
        )}
        {noCredits && (
          <div className="bg-surface-container-low border border-outline-variant rounded-xl p-5 flex flex-col gap-3 mb-4" role="alert">
            <p className="font-medium text-on-surface">You are out of credits.</p>
            <p className="text-label-sm text-on-surface-variant">Purchase a plan to start more conversations.</p>
          </div>
        )}

        <div className="bg-surface-container-low rounded-xl border border-outline-variant/40 p-5 mb-6 space-y-4">
          <div>
            <p className="font-label-sm text-outline uppercase tracking-widest mb-1">Participants</p>
            {participants.map((p, i) => (
              <p key={i} className="font-body-md text-on-surface">{p.name || `Person ${i + 1}`} <span className="text-on-surface-variant">— {p.email}</span></p>
            ))}
          </div>
          <div>
            <p className="font-label-sm text-outline uppercase tracking-widest mb-1">Topic</p>
            <p className="font-body-md text-on-surface">{topic}</p>
          </div>
          {contextSummary && (
            <div>
              <p className="font-label-sm text-outline uppercase tracking-widest mb-1">Preparation notes</p>
              <p className="font-body-md text-on-surface">{contextSummary}</p>
            </div>
          )}
          <div>
            <p className="font-label-sm text-outline uppercase tracking-widest mb-1">Urushi</p>
            <p className="font-body-md text-on-surface">
              {MEDIATOR_PERSONALITY_LABELS[style.personality]} · {INTERVENTION_LABEL[agentSettings.interventionLevel]}
            </p>
            <p className="font-label-sm text-on-surface-variant mt-0.5">
              {agentSettings.voiceGender === 'female' ? 'Female' : 'Male'} voice · {REGION_LABEL[agentSettings.region]}
              {` · ${CONVERSATION_LANGUAGE_LABELS[style.language]}`}
              {style.allowProfanity && ' · strong language on'}
            </p>
          </div>
          <div>
            <p className="font-label-sm text-outline uppercase tracking-widest mb-1">Platform</p>
            <p className="font-body-md text-on-surface">Added on the next screen — Google Meet or Zoom</p>
          </div>
        </div>

        <div className="space-y-3">
          <button
            onClick={() => void handleCreate()}
            disabled={loading}
            className="w-full h-14 bg-primary text-on-primary rounded-xl font-bold text-body-md hover:opacity-90 transition-all active:scale-[0.98] shadow-sm disabled:opacity-60"
          >
            {loading ? 'Preparing…' : 'Prepare Meeting Mediation'}
          </button>
          <button
            onClick={() => setStep('agent')}
            className="w-full h-12 text-on-surface-variant font-label-md hover:text-on-surface transition-colors"
          >
            Edit
          </button>
        </div>

        {roomsRemaining > 0 && (
          <p className="text-center text-label-sm text-outline mt-4">
            {roomsRemaining} conversation room{roomsRemaining !== 1 ? 's' : ''} remaining
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="px-margin-mobile pb-stack-lg max-w-xl mx-auto">
      <div className="flex gap-3 p-4 bg-primary-container/20 rounded-xl border border-primary/20 mb-6 items-start">
        <span className="material-symbols-outlined text-primary shrink-0 text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>video_call</span>
        <p className="text-label-sm text-on-surface-variant leading-snug">
          Invite Urushi to your Google Meet or Zoom call. It mostly listens and steps in only when it helps.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-6">
        {([2, 3] as const).map((count) => (
          <button
            key={count}
            type="button"
            onClick={() => setParticipantCountAndResize(count)}
            className={`rounded-xl border-2 p-4 text-left transition-all ${
              participantCount === count
                ? 'border-primary bg-primary-container/20'
                : 'border-outline-variant bg-surface-container-lowest hover:border-primary/40'
            }`}
          >
            <p className={`font-label-md font-semibold ${participantCount === count ? 'text-primary' : 'text-on-surface'}`}>
              {count} people
            </p>
            <p className="font-label-sm text-on-surface-variant text-[12px] mt-0.5">
              {count === 2 ? 'Just the two of you' : 'You and two others'}
            </p>
          </button>
        ))}
      </div>

      {serverError && (
        <div className="bg-error-container text-on-error-container p-4 rounded-xl font-body-md mb-4" role="alert">{serverError}</div>
      )}
      {noCredits && (
        <div className="bg-surface-container-low border border-outline-variant rounded-xl p-5 flex flex-col gap-3 mb-4" role="alert">
          <p className="font-medium text-on-surface">You are out of credits.</p>
          <p className="text-label-sm text-on-surface-variant">Purchase a plan to start more conversations.</p>
        </div>
      )}

      <form className="space-y-gutter" onSubmit={goToAgentStep} noValidate>
        <div className="space-y-stack-sm">
          <label className="block font-label-md text-on-surface-variant ml-1">Who will be in the conversation?</label>
          <div className="space-y-2">
            {participants.map((p, i) => (
              <div key={i} className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  required
                  maxLength={80}
                  value={p.name}
                  onChange={(e) => updateParticipant(i, 'name', e.target.value)}
                  placeholder={`Person ${i + 1} — first name`}
                  className="w-full h-14 px-4 bg-white border border-outline-variant rounded-xl focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-all placeholder:text-outline/50"
                />
                <input
                  type="email"
                  required
                  maxLength={200}
                  value={p.email}
                  onChange={(e) => updateParticipant(i, 'email', e.target.value)}
                  placeholder="Email address"
                  className="w-full h-14 px-4 bg-white border border-outline-variant rounded-xl focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-all placeholder:text-outline/50"
                />
              </div>
            ))}
          </div>
          {errors['participants'] && (
            <p className="text-error text-label-md ml-1" role="alert">{errors['participants'][0]}</p>
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
            placeholder="How responsibilities and decisions are divided in our business"
            className="w-full h-14 px-4 bg-white border border-outline-variant rounded-xl focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-all placeholder:text-outline/50"
          />
          {errors['topic'] && (
            <p className="text-error text-label-md ml-1" role="alert">{errors['topic'][0]}</p>
          )}
        </div>

        {/* Voice-only: nothing is written, so no script to choose. */}
        <ConversationStyleFields value={style} onChange={setStyle} />

        <div className="space-y-stack-sm">
          <label htmlFor="contextSummary" className="block font-label-md text-on-surface-variant ml-1">
            Anything Urushi should know before the meeting? <span className="text-outline font-normal">(optional)</span>
          </label>
          <textarea
            id="contextSummary"
            rows={3}
            maxLength={4000}
            value={contextSummary}
            onChange={(e) => setContextSummary(e.target.value)}
            placeholder="A little background helps Urushi understand the situation before everyone joins."
            className="w-full px-4 py-3 bg-white border border-outline-variant rounded-xl focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-all placeholder:text-outline/50 resize-none"
          />
        </div>

        <div className="pt-2 space-y-3">
          <button
            type="submit"
            className="w-full h-14 bg-primary text-on-primary rounded-xl font-bold text-body-md hover:opacity-90 transition-all active:scale-[0.98] shadow-sm"
          >
            Continue
          </button>
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
