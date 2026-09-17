'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useRoomSession } from '@/lib/room/useRoomSession'

interface Participant {
  id: string
  name: string
}

interface Props {
  sessionId: string
  caseReference: string
  participants: Participant[]
}

const END_HOLD_MS = 1400

export function LiveRoomView({ sessionId, caseReference, participants }: Props) {
  const router = useRouter()
  const { state, client } = useRoomSession(sessionId)
  const [calibrationIndex, setCalibrationIndex] = useState(0)
  const [ending, setEnding] = useState(false)
  const [endProgress, setEndProgress] = useState(0)
  const [typedInput, setTypedInput] = useState('')
  const [showTypeFallback, setShowTypeFallback] = useState(false)
  const startedRef = useRef(false)
  const endHoldTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    client.start().catch(() => {
      // Error surfaced via state.error already.
    })
    return () => {
      // Strict Mode (dev) mounts this component twice, disposing the client's audio
      // provider between mounts (see useRoomSession's cleanup) — reset so the second
      // mount actually reconnects instead of leaving a disposed, dead session.
      startedRef.current = false
    }
  }, [client])

  async function handleCalibrationTap(participantId: string) {
    await client.calibrateParticipant(participantId)
    if (calibrationIndex + 1 >= participants.length) {
      client.finishCalibration()
    } else {
      setCalibrationIndex((i) => i + 1)
    }
  }

  function startEndHold() {
    setEndProgress(0)
    const startedAt = Date.now()
    endHoldTimer.current = setInterval(() => {
      const pct = Math.min(100, ((Date.now() - startedAt) / END_HOLD_MS) * 100)
      setEndProgress(pct)
      if (pct >= 100) {
        cancelEndHold()
        void confirmEnd()
      }
    }, 30)
  }

  function cancelEndHold() {
    if (endHoldTimer.current) clearInterval(endHoldTimer.current)
    endHoldTimer.current = null
    setEndProgress(0)
  }

  async function confirmEnd() {
    setEnding(true)
    await client.end()
    router.push(`/room/${caseReference}/summary`)
  }

  const statusText = (() => {
    if (state.status === 'connecting') return 'Connecting…'
    if (state.status === 'reconnecting') return 'Connection interrupted. Reconnecting…'
    if (state.assistantSpeaking) return 'Urushi is speaking…'
    if (state.thinking) return 'Urushi is thinking…'
    if (state.paused) return 'Paused'
    return 'Listening…'
  })()

  const currentParticipant = participants[calibrationIndex]

  return (
    <div className="fixed inset-0 bg-[#12211d] text-white flex flex-col overflow-hidden">
      {/* Header */}
      <div className="pt-6 pb-2 text-center shrink-0">
        <p className="font-headline-sm text-white/90 tracking-wide">Urushi Live</p>
      </div>

      {(state.error && state.status !== 'reconnecting') && (
        <div className="mx-6 mb-2 px-4 py-2 bg-error-container/90 text-on-error-container rounded-xl text-label-sm text-center shrink-0">
          {state.error}
        </div>
      )}

      <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
        {state.calibrating && currentParticipant ? (
          <div className="space-y-6 max-w-sm">
            <p className="font-body-lg text-white/80">
              Before we begin, let&apos;s make sure Urushi knows who&apos;s speaking.
            </p>
            <p className="font-headline-md text-white">
              {currentParticipant.name}, please say hello — then tap below.
            </p>
            <button
              onClick={() => void handleCalibrationTap(currentParticipant.id)}
              className="w-full h-16 bg-tertiary text-white rounded-2xl font-bold text-body-lg shadow-lg active:scale-[0.97] transition-transform"
            >
              I said hello
            </button>
            <p className="text-label-sm text-white/50">
              {calibrationIndex + 1} of {participants.length}
            </p>
          </div>
        ) : (
          <>
            {/* Listening indicator */}
            <div className="relative w-40 h-40 mb-10">
              <div
                className={`absolute inset-0 rounded-full bg-tertiary/30 ${
                  state.assistantSpeaking || !state.paused ? 'animate-ping' : ''
                }`}
                style={{ animationDuration: state.assistantSpeaking ? '0.9s' : '2.4s' }}
              />
              <div className="absolute inset-4 rounded-full bg-tertiary/50" />
              <div className="absolute inset-10 rounded-full bg-tertiary flex items-center justify-center">
                <span className="material-symbols-outlined text-white text-[36px]">
                  {state.paused ? 'pause' : 'graphic_eq'}
                </span>
              </div>
            </div>

            <p className="font-headline-sm text-white mb-8">{statusText}</p>

            {state.currentIssueTitle && (
              <div className="mb-3 max-w-xs">
                <p className="text-label-sm text-white/50 uppercase tracking-widest mb-1">Current issue</p>
                <p className="font-body-md text-white/90">&ldquo;{state.currentIssueTitle}&rdquo;</p>
              </div>
            )}

            {state.emergingAgreement && (
              <div className="max-w-xs">
                <p className="text-label-sm text-white/50 uppercase tracking-widest mb-1">Emerging agreement</p>
                <p className="font-body-md text-white/90">&ldquo;{state.emergingAgreement}&rdquo;</p>
              </div>
            )}
          </>
        )}
      </div>

      {showTypeFallback && (
        <form
          className="px-6 pb-3 shrink-0 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!typedInput.trim()) return
            void client.submitTypedUtterance(typedInput.trim())
            setTypedInput('')
          }}
        >
          <input
            value={typedInput}
            onChange={(e) => setTypedInput(e.target.value)}
            placeholder="Type instead of speaking…"
            className="flex-1 h-12 px-4 rounded-xl bg-white/10 text-white placeholder:text-white/40 outline-none border border-white/10 focus:border-tertiary"
          />
          <button type="submit" className="px-4 h-12 rounded-xl bg-tertiary text-white font-label-md">Send</button>
        </form>
      )}

      {/* Bottom controls */}
      <div className="shrink-0 pb-8 pt-4 px-8 flex items-center justify-center gap-6">
        <button
          onClick={() => setShowTypeFallback((v) => !v)}
          className="w-14 h-14 rounded-full bg-white/10 flex items-center justify-center hover:bg-white/20 transition-colors"
          aria-label="Type instead"
        >
          <span className="material-symbols-outlined text-white text-[24px]">keyboard</span>
        </button>

        <button
          onClick={() => void (state.paused ? client.resume() : client.pause())}
          className="w-16 h-16 rounded-full bg-white/15 flex items-center justify-center hover:bg-white/25 transition-colors"
          aria-label={state.paused ? 'Resume' : 'Pause'}
        >
          <span className="material-symbols-outlined text-white text-[28px]">{state.paused ? 'play_arrow' : 'pause'}</span>
        </button>

        <button
          onClick={() => client.setMuted(!state.muted)}
          className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
            state.muted ? 'bg-error text-white' : 'bg-white/10 hover:bg-white/20'
          }`}
          aria-label={state.muted ? 'Unmute' : 'Mute'}
        >
          <span className="material-symbols-outlined text-white text-[24px]">{state.muted ? 'mic_off' : 'mic'}</span>
        </button>

        {/* End session — hold to confirm, hard to trigger by accident */}
        <button
          onPointerDown={startEndHold}
          onPointerUp={cancelEndHold}
          onPointerLeave={cancelEndHold}
          onPointerCancel={cancelEndHold}
          disabled={ending}
          style={{ touchAction: 'none' }}
          className="relative w-16 h-16 rounded-full bg-error/80 flex items-center justify-center overflow-hidden disabled:opacity-60 select-none"
          aria-label="Hold to end session"
        >
          <div
            className="absolute inset-0 bg-error origin-bottom"
            style={{ transform: `scaleY(${endProgress / 100})`, transition: 'transform 30ms linear' }}
          />
          <span className="material-symbols-outlined text-white text-[24px] relative z-10">call_end</span>
        </button>
      </div>
      <p className="text-center text-white/30 text-[11px] pb-4 -mt-2">Hold the red button to end</p>
    </div>
  )
}
