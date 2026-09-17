import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getUser } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { SiteHeader, SiteFooter } from '@/components/SiteHeader'
import { RoomSummaryView } from './RoomSummaryView'
import type { RoomFinalReport } from '@/lib/db/types'

export const metadata: Metadata = {
  title: 'Mediation summary — Urushi Labs',
  robots: { index: false },
}

export default async function RoomSummaryPage({
  params,
}: {
  params: Promise<{ reference: string }>
}) {
  const { reference } = await params

  const user = await getUser()
  if (!user) redirect(`/auth?next=/room/${reference}/summary`)

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
    .select('id, stage, final_report')
    .eq('case_id', caseRow.id)
    .single()

  if (!session) redirect('/dashboard')

  if (!session.final_report && session.stage !== 'completed') {
    redirect(`/room/${reference}/live`)
  }

  return (
    <div className="flex flex-col min-h-screen">
      <SiteHeader userEmail={user.email} logoHref="/" />
      <main className="flex-grow">
        <RoomSummaryView report={session.final_report as RoomFinalReport | null} />
      </main>
      <SiteFooter />
    </div>
  )
}
