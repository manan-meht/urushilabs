import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getUser } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { LiveRoomView } from './LiveRoomView'

export const metadata: Metadata = {
  title: 'Urushi Live — Urushi Labs',
  robots: { index: false },
}

export default async function RoomLivePage({
  params,
}: {
  params: Promise<{ reference: string }>
}) {
  const { reference } = await params

  const user = await getUser()
  if (!user) redirect(`/auth?next=/room/${reference}/live`)

  const db = getServiceClient()
  const { data: caseRow } = await db
    .from('cases')
    .select('id, user_id, conversation_mode')
    .eq('public_reference', reference)
    .eq('conversation_mode', 'room')
    .single()

  if (!caseRow || caseRow.user_id !== user.id) redirect('/dashboard')

  const { data: session } = await db
    .from('room_sessions')
    .select('id, stage')
    .eq('case_id', caseRow.id)
    .single()

  if (!session) redirect('/dashboard')

  if (session.stage === 'setup' || session.stage === 'consent') {
    redirect(`/room/${reference}/consent`)
  }
  if (session.stage === 'completed') {
    redirect(`/room/${reference}/summary`)
  }

  const { data: participants } = await db
    .from('room_participants')
    .select('id, name, participant_index')
    .eq('session_id', session.id)
    .order('participant_index')

  return (
    <LiveRoomView
      sessionId={session.id}
      caseReference={reference}
      participants={(participants ?? []).map((p) => ({ id: p.id, name: p.name }))}
    />
  )
}
