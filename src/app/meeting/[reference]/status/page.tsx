import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getUser } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { SiteHeader, SiteFooter } from '@/components/SiteHeader'
import { MeetingStatusView } from './MeetingStatusView'
import type { DbMeetingParticipant, DbMeetingSession } from '@/lib/db/types'

export const metadata: Metadata = {
  title: 'Meeting Mediation — Urushi Labs',
  robots: { index: false },
}

export default async function MeetingStatusPage({
  params,
}: {
  params: Promise<{ reference: string }>
}) {
  const { reference } = await params

  const user = await getUser()
  if (!user) redirect(`/auth?next=/meeting/${reference}/status`)

  const db = getServiceClient()
  const { data: caseRow } = await db
    .from('cases')
    .select('id, user_id, conversation_mode, public_reference')
    .eq('public_reference', reference)
    .eq('conversation_mode', 'meeting_mediation')
    .single()

  if (!caseRow || caseRow.user_id !== user.id) redirect('/dashboard')

  const { data: session } = await db
    .from('meeting_sessions')
    .select('*')
    .eq('case_id', caseRow.id)
    .single()

  if (!session) redirect('/dashboard')

  const { data: participants } = await db
    .from('meeting_participants')
    .select('id, participant_index, name, is_initiator, context_submitted_at, consented_at, invited_at')
    .eq('session_id', session.id)
    .order('participant_index')

  return (
    <div className="flex flex-col min-h-screen">
      <SiteHeader userEmail={user.email} logoHref="/" />
      <main className="flex-grow">
        <MeetingStatusView
          sessionId={session.id}
          caseReference={reference}
          session={session as DbMeetingSession}
          participants={(participants ?? []) as Array<Pick<DbMeetingParticipant, 'id' | 'participant_index' | 'name' | 'is_initiator' | 'context_submitted_at' | 'consented_at' | 'invited_at'>>}
        />
      </main>
      <SiteFooter />
    </div>
  )
}
