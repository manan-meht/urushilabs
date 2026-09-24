'use client'

import { useState } from 'react'
import { StartConversationForm } from './StartConversationForm'
import { TogetherSetupForm } from './TogetherSetupForm'
import { RoomSetupForm } from './RoomSetupForm'
import { MeetingSetupForm } from './MeetingSetupForm'

/**
 * 'together-medium' is the step where a co-located pair picks how they want to
 * talk. Together and Live Mediation used to be two separate cards, which asked
 * people to choose between an implementation detail (one shared screen versus a
 * microphone) before they had chosen what they were doing. They are one
 * situation — the two of us, in a room, now — with two ways of carrying it.
 */
type Mode = 'invite' | 'together-medium' | 'together' | 'live' | 'meeting' | null

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

  if (mode === 'together-medium') {
    return (
      <div className="px-margin-mobile pb-stack-lg max-w-xl mx-auto">
        <button
          onClick={() => setMode(null)}
          className="flex items-center gap-1 text-label-sm text-secondary hover:text-on-surface transition-colors mb-4 ml-4 mt-2 md:ml-0"
          aria-label="Change conversation mode"
        >
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          Change mode
        </button>

        <div className="mb-6">
          <h2 className="font-headline-sm text-on-surface mb-1">How do you want to talk?</h2>
          <p className="font-body-md text-on-surface-variant leading-snug">
            Both work the same way — Urushi listens, steps in when it helps, and writes up what you agree.
          </p>
        </div>

        <div className="space-y-4">
          {liveMediationEnabled && (
            <button
              onClick={() => setMode('live')}
              className="w-full text-left bg-surface-container-lowest border-2 border-outline-variant hover:border-tertiary rounded-2xl p-6 transition-all group focus:outline-none focus:border-tertiary"
              aria-label="Talk out loud with Urushi listening"
            >
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-full bg-tertiary-container flex items-center justify-center shrink-0 group-hover:bg-tertiary transition-colors">
                  <span className="material-symbols-outlined text-white text-[24px]" style={{ fontVariationSettings: "'FILL' 1" }}>record_voice_over</span>
                </div>
                <div className="flex-1">
                  <p className="font-headline-sm text-on-surface mb-1 group-hover:text-tertiary transition-colors">
                    Out loud
                  </p>
                  <p className="font-body-md text-on-surface-variant leading-snug">
                    Put your phone between you and talk normally. Urushi listens and speaks up when it helps.
                  </p>
                </div>
                <span className="material-symbols-outlined text-outline group-hover:text-tertiary transition-colors self-center">chevron_right</span>
              </div>
            </button>
          )}

          <button
            onClick={() => setMode('together')}
            className="w-full text-left bg-surface-container-lowest border-2 border-outline-variant hover:border-secondary rounded-2xl p-6 transition-all group focus:outline-none focus:border-secondary"
            aria-label="Type on one shared device"
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-full bg-secondary-container flex items-center justify-center shrink-0 group-hover:bg-secondary transition-colors">
                <span className="material-symbols-outlined text-white text-[24px]" style={{ fontVariationSettings: "'FILL' 1" }}>keyboard</span>
              </div>
              <div className="flex-1">
                <p className="font-headline-sm text-on-surface mb-1 group-hover:text-secondary transition-colors">
                  By typing
                </p>
                <p className="font-body-md text-on-surface-variant leading-snug">
                  Take turns typing on one shared device. Useful somewhere quiet, or when writing it down helps.
                </p>
              </div>
              <span className="material-symbols-outlined text-outline group-hover:text-secondary transition-colors self-center">chevron_right</span>
            </div>
          </button>
        </div>
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
                A written conversation, on their own device, in their own time. They answer
                Urushi&apos;s questions by typing — there is nothing to join and no call to be on.
              </p>
              <p className="font-label-sm text-on-surface-variant/80 mt-2 flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]">chat_bubble</span>
                Chat based · you do not need to be together
              </p>
            </div>
            <span className="material-symbols-outlined text-outline group-hover:text-primary transition-colors self-center">chevron_right</span>
          </div>
        </button>

        {/* Option 2 — We're together now (voice or text chosen next) */}
        <button
          onClick={() => setMode(liveMediationEnabled ? 'together-medium' : 'together')}
          className="w-full text-left bg-surface-container-lowest border-2 border-outline-variant hover:border-secondary rounded-2xl p-6 transition-all group focus:outline-none focus:border-secondary"
          aria-label="Start a conversation with the other person present"
        >
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-full bg-secondary-container flex items-center justify-center shrink-0 group-hover:bg-secondary transition-colors">
              <span className="material-symbols-outlined text-white text-[24px]" style={{ fontVariationSettings: "'FILL' 1" }}>groups</span>
            </div>
            <div className="flex-1">
              <p className="font-headline-sm text-on-surface mb-1 group-hover:text-secondary transition-colors">
                We&apos;re together now
              </p>
              <p className="font-body-md text-on-surface-variant leading-snug">
                Both of you in the same place, right now, with Urushi guiding the conversation.
              </p>
              <p className="font-label-sm text-on-surface-variant/80 mt-2 flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]">record_voice_over</span>
                {liveMediationEnabled ? 'Talk out loud or type — you choose next' : 'Take turns typing on one shared device'}
              </p>
            </div>
            <span className="material-symbols-outlined text-outline group-hover:text-secondary transition-colors self-center">chevron_right</span>
          </div>
        </button>

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
