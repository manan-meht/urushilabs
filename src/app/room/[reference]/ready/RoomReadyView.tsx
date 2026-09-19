'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { DevicePairing } from './DevicePairing'
import { ConversationSettingsAgreement } from '@/components/ConversationSettingsAgreement'
import { ConversationSettingsSummary } from '@/components/ConversationSettingsSummary'
import type { ConversationSettings } from '@/lib/conversation/settings'

interface Props {
  sessionId: string
  caseReference: string
  caseId: string
  settings: ConversationSettings
  /**
   * The settings changed since anyone last agreed to them, so the earlier
   * acceptance no longer counts and has to be collected again before the
   * session can run under them.
   */
  needsAcceptance: boolean
}

const TIPS = [
  'Put the phone near the middle of the table',
  'Turn the volume up',
  'Keep the device connected to power for longer conversations',
  'Try to avoid loud background noise',
]

export function RoomReadyView({ sessionId, caseReference, caseId, settings, needsAcceptance }: Props) {
  const router = useRouter()
  const [accepted, setAccepted] = useState(!needsAcceptance)

  return (
    <div className="px-margin-mobile pt-stack-lg pb-stack-lg max-w-lg mx-auto text-center">
      <div className="w-16 h-16 bg-tertiary-container rounded-full flex items-center justify-center mx-auto mb-6">
        <span className="material-symbols-outlined text-white text-[32px]" style={{ fontVariationSettings: "'FILL' 1" }}>smartphone</span>
      </div>

      <h1 className="font-headline-xl-mobile text-headline-xl-mobile text-on-surface mb-3">Ready for Live Mediation</h1>
      <p className="font-body-md text-on-surface-variant mb-8">
        Place this device somewhere everyone can hear and be heard.
      </p>

      {!accepted ? (
        <div className="mb-8 text-left">
          <ConversationSettingsAgreement
            caseId={caseId}
            settings={settings}
            sharedDevice
            onAccepted={() => setAccepted(true)}
            onDeclined={() => router.push(`/room/${caseReference}/consent`)}
          />
        </div>
      ) : (
        <div className="mb-8 text-left">
          <ConversationSettingsSummary caseId={caseId} settings={settings} />
        </div>
      )}

      <div className="bg-surface-container-low rounded-xl border border-outline-variant/40 p-5 text-left mb-8">
        <p className="font-label-sm text-outline uppercase tracking-widest mb-3">Suggestions</p>
        <ul className="space-y-2">
          {TIPS.map((tip) => (
            <li key={tip} className="flex items-start gap-2 font-body-md text-on-surface-variant">
              <span className="material-symbols-outlined text-tertiary text-[18px] shrink-0 mt-0.5">check_circle</span>
              {tip}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex gap-3 p-4 bg-tertiary-container/20 rounded-xl border border-tertiary/20 mb-6 items-start text-left">
        <span className="material-symbols-outlined text-tertiary shrink-0 text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>mic</span>
        <p className="text-label-sm text-on-surface-variant leading-snug">
          Your browser will ask for microphone permission when you press Start mediation — Urushi isn&apos;t listening
          until then.
        </p>
      </div>

      <DevicePairing sessionId={sessionId} />

      <div className="space-y-3">
        <button
          onClick={() => router.push(`/room/${caseReference}/live`)}
          className="w-full h-14 bg-tertiary text-white rounded-xl font-bold text-body-md hover:opacity-90 transition-all active:scale-[0.98] shadow-sm"
        >
          Start mediation
        </button>
        <button
          onClick={() => router.back()}
          className="w-full h-12 text-on-surface-variant font-label-md hover:text-on-surface transition-colors"
        >
          Back
        </button>
      </div>
    </div>
  )
}
