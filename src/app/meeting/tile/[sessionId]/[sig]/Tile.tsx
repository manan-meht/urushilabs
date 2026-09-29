'use client'

import { useEffect, useState } from 'react'

type Status = 'listening' | 'thinking' | 'speaking'

const LABEL: Record<Status, string> = {
  listening: 'Listening',
  thinking: 'About to speak…',
  speaking: 'Speaking',
}

const COLOUR: Record<Status, string> = {
  listening: '#6b7785',
  thinking: '#f5b942',
  speaking: '#4fd08c',
}

/**
 * Polls once a second. The interesting transition — listening to thinking —
 * happens the moment Stage A approves, ten-plus seconds before any audio, so a
 * one-second poll is well inside the window it exists to fill.
 */
export function Tile({ sessionId, sig }: { sessionId: string; sig: string }) {
  const [status, setStatus] = useState<Status>('listening')
  const [stale, setStale] = useState(false)

  useEffect(() => {
    let cancelled = false
    let misses = 0

    async function poll() {
      try {
        const res = await fetch(`/api/meeting/status/${sessionId}/${sig}`, { cache: 'no-store' })
        if (res.ok) {
          const body = (await res.json()) as { status?: Status }
          if (!cancelled && body.status) setStatus(body.status)
          misses = 0
          setStale(false)
        } else {
          misses++
        }
      } catch {
        misses++
      }
      // Say so if the feed dies, rather than showing a confident stale state.
      if (misses >= 5) setStale(true)
      if (!cancelled) setTimeout(poll, 1000)
    }

    void poll()
    return () => {
      cancelled = true
    }
  }, [sessionId, sig])

  const colour = COLOUR[status]

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#0b0f14',
        color: '#e9eef4',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        gap: '3vh',
      }}
    >
      <style>{`
        @keyframes urushi-pulse { 0%,100% { transform: scale(1); opacity: .75 } 50% { transform: scale(1.35); opacity: 1 } }
        @keyframes urushi-bar { 0%,100% { height: 22% } 50% { height: 100% } }
      `}</style>

      <div style={{ height: '18vh', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1.2vw' }}>
        {status === 'speaking' ? (
          [0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              style={{
                display: 'block',
                width: '2.2vw',
                height: '60%',
                borderRadius: '1vw',
                background: colour,
                animation: `urushi-bar ${0.7 + i * 0.13}s ease-in-out infinite`,
              }}
            />
          ))
        ) : (
          <span
            style={{
              display: 'block',
              width: '9vw',
              height: '9vw',
              borderRadius: '50%',
              background: colour,
              boxShadow: status === 'thinking' ? `0 0 6vw ${colour}` : 'none',
              animation: status === 'thinking' ? 'urushi-pulse 1.1s ease-in-out infinite' : 'none',
            }}
          />
        )}
      </div>

      <div style={{ fontSize: 'clamp(28px, 11vw, 160px)', fontWeight: 700, letterSpacing: '-0.02em', color: colour, textAlign: 'center', lineHeight: 1 }}>
        {LABEL[status]}
      </div>

      <div style={{ fontSize: 'clamp(12px, 3vw, 36px)', color: '#8a96a3', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
        {stale ? 'Urushi · connection lost' : 'Urushi'}
      </div>
    </div>
  )
}
