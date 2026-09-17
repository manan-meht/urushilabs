'use client'

import { useEffect, useRef, useState } from 'react'
import { RoomSessionClient, type RoomSessionState } from './roomSessionClient'

export function useRoomSession(sessionId: string) {
  const clientRef = useRef<RoomSessionClient | null>(null)
  if (!clientRef.current) clientRef.current = new RoomSessionClient(sessionId)

  const [state, setState] = useState<RoomSessionState>({
    status: 'idle',
    assistantSpeaking: false,
    thinking: false,
    muted: false,
    paused: false,
    currentIssueTitle: null,
    emergingAgreement: null,
    transcript: [],
    error: null,
    lastDiarizationLabel: null,
    calibrating: true,
  })

  useEffect(() => {
    const client = clientRef.current!
    const unsubscribe = client.subscribe(setState)
    return () => {
      unsubscribe()
      void client.dispose()
    }
    // sessionId is fixed for the lifetime of this hook instance (new RoomSessionClient per id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { state, client: clientRef.current }
}
