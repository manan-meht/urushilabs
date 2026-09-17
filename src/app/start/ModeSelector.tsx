'use client'

import { useState } from 'react'
import { StartConversationForm } from './StartConversationForm'
import { TogetherSetupForm } from './TogetherSetupForm'
import { RoomSetupForm } from './RoomSetupForm'
import { MeetingSetupForm } from './MeetingSetupForm'

type Mode = 'invite' | 'together' | 'live' | 'meeting' | null

interface Props {
  userFirstName: string
  userEmail: string | null
  roomsRemaining: number
  liveMediationEnabled?: boolean
  meetingMediationEnabled?: boolean
  existingCases?: Array<{ reference: string; topic: string }>
}

export function ModeSelector({ userFirstName, userEmail, roomsRemaining, liveMediationEnabled, meetingMediationEnabled, existingCases }: Props) {
  const [mode, setMode] = useState<Mode>(null)

  if (mode === 'invite') {
    return (
      <div>
        <button
          onClick={() => setMode(null)}
          className="flex items-center gap-1 text-label-sm text-secondary hover:text-on-surface transition-colors mb-4 ml-4 mt-2 md:ml-0"
          aria-label="Change conversation mode"
        >
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          Change mode
        </button>
        <StartConversationForm
          userFirstName={userFirstName}
          userEmail={userEmail}
          roomsRemaining={roomsRemaining}
        />
      </div>
    )
  }

  if (mode === 'together') {
    return (
      <div>
        <button
          onClick={() => setMode(null)}
          className="flex items-center gap-1 text-label-sm text-secondary hover:text-on-surface transition-colors mb-4 ml-4 mt-2 md:ml-0"
          aria-label="Change conversation mode"
        >
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          Change mode
        </button>
        <TogetherSetupForm
          userFirstName={userFirstName}
          userEmail={userEmail}
          roomsRemaining={roomsRemaining}
        />
      </div>
    )
  }

  if (mode === 'live') {
    return (
      <div>
        <button
          onClick={() => setMode(null)}
          className="flex items-center gap-1 text-label-sm text-secondary hover:text-on-surface transition-colors mb-4 ml-4 mt-2 md:ml-0"
          aria-label="Change conversation mode"
        >
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          Change mode
        </button>
        <RoomSetupForm
          userFirstName={userFirstName}
          roomsRemaining={roomsRemaining}
          existingCases={existingCases ?? []}
        />
      </div>
    )
  }

  if (mode === 'meeting') {
    return (
      <div>
        <button
          onClick={() => setMode(null)}
          className="flex items-center gap-1 text-label-sm text-secondary hover:text-on-surface transition-colors mb-4 ml-4 mt-2 md:ml-0"
          aria-label="Change conversation mode"
        >
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          Change mode
        </button>
        <MeetingSetupForm
          userFirstName={userFirstName}
          userEmail={userEmail}
          roomsRemaining={roomsRemaining}
        />
      </div>
    )
  }

  // Mode selection screen
  return (
    <div className="px-margin-mobile pb-stack-lg max-w-xl mx-auto">
      <div className="space-y-4">
        {/* Option 1 — Invite */}
        <button
          onClick={() => setMode('invite')}
          className="w-full text-left bg-surface-container-lowest border-2 border-outline-variant hover:border-primary rounded-2xl p-6 transition-all group focus:outline-none focus:border-primary"
          aria-label="Invite the other person to respond separately"
        >
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-full bg-primary-container flex items-center justify-center shrink-0 group-hover:bg-primary transition-colors">
              <span className="material-symbols-outlined text-white text-[24px]" style={{ fontVariationSettings: "'FILL' 1" }}>mail</span>
            </div>
            <div className="flex-1">
              <p className="font-headline-sm text-on-surface mb-1 group-hover:text-primary transition-colors">
                Invite the other person
              </p>
              <p className="font-body-md text-on-surface-variant leading-snug">
                They can share their perspective when they are ready, on their own device.
              </p>
            </div>
            <span className="material-symbols-outlined text-outline group-hover:text-primary transition-colors self-center">chevron_right</span>
          </div>
        </button>

        {/* Option 2 — Together */}
        <button
          onClick={() => setMode('together')}
          className="w-full text-left bg-surface-container-lowest border-2 border-outline-variant hover:border-secondary rounded-2xl p-6 transition-all group focus:outline-none focus:border-secondary"
          aria-label="Start a together mode conversation"
        >
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-full bg-secondary-container flex items-center justify-center shrink-0 group-hover:bg-secondary transition-colors">
              <span className="material-symbols-outlined text-white text-[24px]" style={{ fontVariationSettings: "'FILL' 1" }}>groups</span>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <p className="font-headline-sm text-on-surface group-hover:text-secondary transition-colors">
                  We&apos;re together now
                </p>
              </div>
              <p className="font-body-md text-on-surface-variant leading-snug">
                Take turns sharing your perspectives while Urushi guides the conversation on one shared device.
              </p>
            </div>
            <span className="material-symbols-outlined text-outline group-hover:text-secondary transition-colors self-center">chevron_right</span>
          </div>
        </button>

        {liveMediationEnabled && (
          <button
            onClick={() => setMode('live')}
            className="w-full text-left bg-surface-container-lowest border-2 border-outline-variant hover:border-tertiary rounded-2xl p-6 transition-all group focus:outline-none focus:border-tertiary"
            aria-label="Start a live in-person mediation"
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-full bg-tertiary-container flex items-center justify-center shrink-0 group-hover:bg-tertiary transition-colors">
                <span className="material-symbols-outlined text-white text-[24px]" style={{ fontVariationSettings: "'FILL' 1" }}>record_voice_over</span>
              </div>
              <div className="flex-1">
                <p className="font-headline-sm text-on-surface mb-1 group-hover:text-tertiary transition-colors">
                  Live Mediation
                </p>
                <p className="font-body-md text-on-surface-variant leading-snug">
                  Put your phone in the middle. Urushi listens and guides the conversation in real time.
                </p>
              </div>
              <span className="material-symbols-outlined text-outline group-hover:text-tertiary transition-colors self-center">chevron_right</span>
            </div>
          </button>
        )}

        {meetingMediationEnabled && (
          <button
            onClick={() => setMode('meeting')}
            className="w-full text-left bg-surface-container-lowest border-2 border-outline-variant hover:border-primary rounded-2xl p-6 transition-all group focus:outline-none focus:border-primary"
            aria-label="Start a meeting mediation over Google Meet or Zoom"
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-full bg-primary-container flex items-center justify-center shrink-0 group-hover:bg-primary transition-colors">
                <span className="material-symbols-outlined text-white text-[24px]" style={{ fontVariationSettings: "'FILL' 1" }}>video_call</span>
              </div>
              <div className="flex-1">
                <p className="font-headline-sm text-on-surface mb-1 group-hover:text-primary transition-colors">
                  Meeting Mediation
                </p>
                <p className="font-body-md text-on-surface-variant leading-snug">
                  Invite Urushi to your Google Meet or Zoom call. It listens, steps in when useful, and helps the group reach clear agreements.
                </p>
              </div>
              <span className="material-symbols-outlined text-outline group-hover:text-primary transition-colors self-center">chevron_right</span>
            </div>
          </button>
        )}
      </div>

      <p className="text-center text-label-sm text-outline mt-6">
        {roomsRemaining} conversation room{roomsRemaining !== 1 ? 's' : ''} remaining
      </p>
    </div>
  )
}
