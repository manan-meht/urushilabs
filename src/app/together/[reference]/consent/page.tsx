import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getUser } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { getParticipantSession } from '@/lib/auth/togetherParticipantSession'
import { SiteHeader, SiteFooter } from '@/components/SiteHeader'
import { ConsentChecklist } from './ConsentChecklist'
import { conversationSettingsFromRow } from '@/lib/conversation/settings'

export const metadata: Metadata = {
  title: 'Before you begin — Urushi Labs',
  robots: { index: false },
}

export default async function ConsentPage({
  params,
}: {
  params: Promise<{ reference: string }>
}) {
  const { reference } = await params

  // Person B joins via QR — they skip consent (Person A confirmed for both)
  const participantSession = await getParticipantSession()
  if (participantSession && participantSession.caseReference === reference) {
    redirect(`/together/${reference}/session`)
  }

  const user = await getUser()
  if (!user) redirect(`/auth?next=/together/${reference}/consent`)

  const db = getServiceClient()
  const { data: caseRow } = await db
    .from('cases')
    .select('id, user_id, conversation_mode, conversation_language, mediator_personality, allow_profanity, text_script, conversation_settings_version')
    .eq('public_reference', reference)
    .eq('conversation_mode', 'together')
    .single()

  if (!caseRow || caseRow.user_id !== user.id) redirect('/dashboard')

  const { data: session } = await db
    .from('together_sessions')
    .select('id, stage, person_a_name, person_b_name, topic, device_mode')
    .eq('case_id', caseRow.id)
    .single()

  if (!session) redirect('/dashboard')

  // If already past consent, redirect to session
  if (session.stage !== 'consent') {
    redirect(`/together/${reference}/session`)
  }

  return (
    <div className="flex flex-col min-h-screen">
      <SiteHeader userEmail={user.email} logoHref="/" />
      <main className="flex-grow">
        <ConsentChecklist
          caseId={caseRow.id}
          settings={conversationSettingsFromRow(caseRow)}
          sharedDevice={session.device_mode !== 'separate'}
          sessionId={session.id}
          caseReference={reference}
          personAName={session.person_a_name}
          personBName={session.person_b_name}
          topic={session.topic}
        />
      </main>
      <SiteFooter />
    </div>
  )
}
