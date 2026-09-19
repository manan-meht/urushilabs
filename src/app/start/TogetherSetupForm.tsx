'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { QRCodeSVG } from 'qrcode.react'
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

type DeviceMode = 'shared' | 'separate'

interface CreatedSession {
  caseReference: string
  sessionId: string
  deviceMode: DeviceMode
  personBToken?: string
  personBName: string
}

export function TogetherSetupForm({ userFirstName, roomsRemaining }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<Record<string, string[]>>({})
  const [serverError, setServerError] = useState('')
  const [noCredits, setNoCredits] = useState(false)
  const [personAName, setPersonAName] = useState(userFirstName)
  const [deviceMode, setDeviceMode] = useState<DeviceMode>('shared')
  const [style, setStyle] = useState<ConversationStyleValue>(DEFAULT_CONVERSATION_STYLE_VALUE)
  const [created, setCreated] = useState<CreatedSession | null>(null)
  const [linkCopied, setLinkCopied] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setErrors({})
    setServerError('')
    setNoCredits(false)

    const fd = new FormData(e.currentTarget)
    const personBName = fd.get('personBName') as string
    const body = {
      personAName: fd.get('personAName'),
      personBName,
      topic: fd.get('topic'),
      relationship: fd.get('relationship') || undefined,
      deviceMode,
      conversationSettings: {
        language: style.language,
        personality: style.personality,
        allowProfanity: style.allowProfanity,
        textScript: style.textScript,
      },
    }

    try {
      const res = await fetch('/api/together/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const data = await res.json() as {
        caseReference?: string
        sessionId?: string
        deviceMode?: DeviceMode
        personBToken?: string
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
        if (deviceMode === 'shared') {
          router.push(`/together/${data.caseReference}/consent`)
        } else {
          // Show QR + link before proceeding
          setCreated({
            caseReference: data.caseReference,
            sessionId: data.sessionId!,
            deviceMode: data.deviceMode ?? 'separate',
            personBToken: data.personBToken,
            personBName,
          })
        }
      }
    } catch {
      setServerError('A network error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // ─── QR / link screen (separate-device mode after creation) ─────────────────
  if (created?.deviceMode === 'separate' && created.personBToken) {
    const joinUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/api/together/join/${created.personBToken}`

    async function copyLink() {
      await navigator.clipboard.writeText(joinUrl)
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2500)
    }

    return (
      <div className="px-margin-mobile pb-stack-lg max-w-lg mx-auto text-center space-y-6">
        <div className="space-y-2">
          <div className="w-14 h-14 bg-secondary-container rounded-full flex items-center justify-center mx-auto">
            <span className="material-symbols-outlined text-white text-[28px]" style={{ fontVariationSettings: "'FILL' 1" }}>qr_code_2</span>
          </div>
          <h2 className="font-headline-md text-on-surface">Share with {created.personBName}</h2>
          <p className="font-body-md text-on-surface-variant">
            Ask {created.personBName} to scan this QR code or open the link on their device. They&apos;ll join straight into the conversation.
          </p>
        </div>

        {/* QR code */}
        <div className="flex items-center justify-center p-6 bg-white rounded-2xl border border-outline-variant shadow-sm inline-block mx-auto">
          <QRCodeSVG value={joinUrl} size={200} level="M" />
        </div>

        {/* Copy link */}
        <div className="flex gap-2">
          <input
            readOnly
            value={joinUrl}
            className="flex-1 px-3 py-2.5 border border-outline-variant rounded-xl font-body-md text-on-surface-variant text-sm bg-surface-container-lowest truncate"
          />
          <button
            onClick={() => void copyLink()}
            className="shrink-0 px-4 py-2.5 border border-outline-variant rounded-xl font-label-md text-on-surface hover:bg-surface-container-low transition-all flex items-center gap-2"
          >
            <span className="material-symbols-outlined text-[16px]">{linkCopied ? 'check' : 'content_copy'}</span>
            {linkCopied ? 'Copied!' : 'Copy link'}
          </button>
        </div>

        <div className="bg-surface-container-low rounded-xl p-4 text-left space-y-1.5 border border-outline-variant/40">
          <p className="font-label-sm text-on-surface-variant text-[12px] uppercase tracking-widest">What happens next</p>
          <ol className="space-y-1 list-decimal list-inside font-body-md text-on-surface-variant text-sm leading-relaxed">
            <li>{created.personBName} scans the QR or opens the link</li>
            <li>You both start the conversation — each on your own device</li>
            <li>Urushi guides you turn by turn</li>
          </ol>
        </div>

        <button
          onClick={() => router.push(`/together/${created.caseReference}/consent`)}
          className="w-full h-14 bg-secondary text-white rounded-xl font-bold text-body-md hover:bg-on-secondary-fixed-variant transition-all active:scale-[0.98] shadow-sm"
        >
          I&apos;ve shared it — continue to consent
        </button>
      </div>
    )
  }

  // ─── Setup form ──────────────────────────────────────────────────────────────
  return (
    <div className="px-margin-mobile pb-stack-lg max-w-xl mx-auto">

      {/* Device mode selector */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        {([
          { mode: 'shared' as const, icon: 'smartphone', label: 'Same device', desc: 'Pass the phone back and forth' },
          { mode: 'separate' as const, icon: 'devices', label: 'Own devices', desc: 'Each person uses their own phone' },
        ] as const).map(({ mode, icon, label, desc }) => (
          <button
            key={mode}
            type="button"
            onClick={() => setDeviceMode(mode)}
            className={`rounded-xl border-2 p-4 text-left transition-all ${
              deviceMode === mode
                ? 'border-secondary bg-secondary-container/20'
                : 'border-outline-variant bg-surface-container-lowest hover:border-secondary/40'
            }`}
          >
            <span className={`material-symbols-outlined text-[24px] mb-2 block ${deviceMode === mode ? 'text-secondary' : 'text-outline'}`} style={{ fontVariationSettings: "'FILL' 1" }}>{icon}</span>
            <p className={`font-label-md font-semibold ${deviceMode === mode ? 'text-secondary' : 'text-on-surface'}`}>{label}</p>
            <p className="font-label-sm text-on-surface-variant text-[12px] mt-0.5">{desc}</p>
          </button>
        ))}
      </div>

      {deviceMode === 'separate' && (
        <div className="flex gap-3 p-4 bg-secondary-container/20 rounded-xl border border-secondary/20 mb-6 items-start">
          <span className="material-symbols-outlined text-secondary shrink-0 text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>qr_code_2</span>
          <p className="text-label-sm text-on-surface-variant leading-snug">
            After setup you&apos;ll get a QR code and link to share with the other person. They join on their own device.
          </p>
        </div>
      )}

      {deviceMode === 'shared' && (
        <div className="flex gap-3 p-4 bg-secondary-container/20 rounded-xl border border-secondary/20 mb-6 items-start">
          <span className="material-symbols-outlined text-secondary shrink-0 text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>groups</span>
          <p className="text-label-sm text-on-surface-variant leading-snug">
            You will take turns sharing your perspectives on the same device. Urushi will guide you through each step.
          </p>
        </div>
      )}

      {noCredits && (
        <div className="bg-surface-container-low border border-outline-variant rounded-xl p-5 flex flex-col gap-3 mb-4" role="alert">
          <p className="font-medium text-on-surface">You are out of credits.</p>
          <p className="text-label-sm text-on-surface-variant">Purchase a plan to start more conversations.</p>
        </div>
      )}

      {serverError && (
        <div className="bg-error-container text-on-error-container p-4 rounded-xl font-body-md mb-4" role="alert">
          {serverError}
        </div>
      )}

      <form className="space-y-gutter" onSubmit={handleSubmit} noValidate>

        <div className="space-y-stack-sm">
          <label htmlFor="personAName" className="block font-label-md text-on-surface-variant ml-1">
            Your name (Person A)
          </label>
          <input
            id="personAName"
            name="personAName"
            type="text"
            required
            maxLength={80}
            value={personAName}
            onChange={e => setPersonAName(e.target.value)}
            placeholder="e.g., Alex"
            className="w-full h-14 px-4 bg-white border border-outline-variant rounded-xl focus:border-secondary focus:ring-1 focus:ring-secondary outline-none transition-all placeholder:text-outline/50"
          />
          {errors['personAName'] && (
            <p className="text-error text-label-md ml-1" role="alert">{errors['personAName'][0]}</p>
          )}
        </div>

        <div className="space-y-stack-sm">
          <label htmlFor="personBName" className="block font-label-md text-on-surface-variant ml-1">
            The other person&apos;s name (Person B)
          </label>
          <input
            id="personBName"
            name="personBName"
            type="text"
            required
            maxLength={80}
            placeholder="e.g., Jordan"
            className="w-full h-14 px-4 bg-white border border-outline-variant rounded-xl focus:border-secondary focus:ring-1 focus:ring-secondary outline-none transition-all placeholder:text-outline/50"
          />
          {errors['personBName'] && (
            <p className="text-error text-label-md ml-1" role="alert">{errors['personBName'][0]}</p>
          )}
        </div>

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

        <div className="space-y-stack-sm">
          <label htmlFor="topic" className="block font-label-md text-on-surface-variant ml-1">
            What would you like to discuss?
          </label>
          <p className="text-label-sm text-on-surface-variant ml-1">Describe the subject, not who is at fault. Both of you will see this.</p>
          <input
            id="topic"
            name="topic"
            type="text"
            required
            maxLength={120}
            placeholder="e.g., How we make decisions about our business"
            className="w-full h-14 px-4 bg-white border border-outline-variant rounded-xl focus:border-secondary focus:ring-1 focus:ring-secondary outline-none transition-all placeholder:text-outline/50"
          />
          {errors['topic'] && (
            <p className="text-error text-label-md ml-1" role="alert">{errors['topic'][0]}</p>
          )}
        </div>

        {/* Script matters here: both people type their turns. */}
        <ConversationStyleFields value={style} onChange={setStyle} showScript />

        <div className="pt-2 space-y-3">
          <button
            type="submit"
            disabled={loading}
            className="w-full h-14 bg-secondary text-white rounded-xl font-bold text-body-md hover:bg-on-secondary-fixed-variant transition-all active:scale-[0.98] shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Setting up your conversation…
              </span>
            ) : deviceMode === 'separate' ? 'Set up and get QR code' : 'Begin together conversation'}
          </button>
          <p className="text-center text-label-sm text-on-surface-variant">Usually takes 15–30 minutes.</p>
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
