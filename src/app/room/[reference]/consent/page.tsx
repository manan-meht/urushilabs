import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getUser } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { SiteHeader, SiteFooter } from '@/components/SiteHeader'
import { RoomConsentChecklist } from './RoomConsentChecklist'
import { conversationSettingsFromRow } from '@/lib/conversation/settings'

export const metadata: Metadata = {
  title: 'Before you begin — Urushi Labs',
  robots: { index: false },
}

export default async function RoomConsentPage({
  params,
}: {
  params: Promise<{ reference: string }>
}) {
  const { reference } = await params

  const user = await getUser()
  if (!user) redirect(`/auth?next=/room/${reference}/consent`)

  const db = getServiceClient()
  const { data: caseRow } = await db
    .from('cases')
    .select('id, user_id, conversation_mode, conversation_language, mediator_personality, allow_profanity, text_script, conversation_settings_version')
    .eq('public_reference', reference)
    .eq('conversation_mode', 'room')
    .single()

  if (!caseRow || caseRow.user_id !== user.id) redirect('/dashboard')

  const { data: session } = await db
    .from('room_sessions')
    .select('id, stage, topic, participant_count')
    .eq('case_id', caseRow.id)
    .single()

  if (!session) redirect('/dashboard')

  if (session.stage !== 'setup' && session.stage !== 'consent') {
    redirect(`/room/${reference}/ready`)
  }

  const { data: participants } = await db
    .from('room_participants')
    .select('name, participant_index')
    .eq('session_id', session.id)
    .order('participant_index')

  return (
    <div className="flex flex-col min-h-screen">
      <SiteHeader userEmail={user.email} logoHref="/" />
      <main className="flex-grow">
        <RoomConsentChecklist
          caseId={caseRow.id}
          settings={conversationSettingsFromRow(caseRow)}
          sessionId={session.id}
          caseReference={reference}
          participantNames={(participants ?? []).map((p) => p.name)}
          topic={session.topic}
        />
      </main>
      <SiteFooter />
    </div>
  )
}
