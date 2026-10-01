import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getUser } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { PrintButton } from './PrintButton'
import type { DbMeetingSession } from '@/lib/db/types'

export const metadata: Metadata = {
  title: 'Meeting report — Urushi Labs',
  robots: { index: false },
}

/**
 * A clean, print-ready copy of the meeting report for the case owner. No site
 * chrome; what prints is the report. Opened with ?print=1 it goes straight to
 * the print dialog, which is where "Download PDF" on the status page sends you.
 */
export default async function MeetingReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ reference: string }>
  searchParams: Promise<{ print?: string }>
}) {
  const { reference } = await params
  const { print } = await searchParams

  const user = await getUser()
  if (!user) redirect(`/auth?next=/meeting/${reference}/report`)

  const db = getServiceClient()
  const { data: caseRow } = await db
    .from('cases')
    .select('id, user_id')
    .eq('public_reference', reference)
    .eq('conversation_mode', 'meeting_mediation')
    .single()
  if (!caseRow || caseRow.user_id !== user.id) redirect('/dashboard')

  const { data: sessionRow } = await db.from('meeting_sessions').select('*').eq('case_id', caseRow.id).single()
  const session = sessionRow as DbMeetingSession | null
  if (!session) redirect('/dashboard')
  if (!session.final_report) redirect(`/meeting/${reference}/status`)

  const { data: participants } = await db
    .from('meeting_participants')
    .select('name')
    .eq('session_id', session.id)
    .order('participant_index')

  const report = session.final_report
  const date = session.ended_at
    ? new Date(session.ended_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : null

  return (
    <main className="min-h-screen bg-white text-[#1a1c1b] print:bg-white">
      <div className="max-w-[720px] mx-auto px-6 py-10 print:px-0 print:py-0">
        <div className="print:hidden mb-6">
          <Link href={`/meeting/${reference}/status`} className="text-label-sm text-secondary underline">← Back to the meeting</Link>
        </div>
        <PrintButton autoPrint={print === '1'} />

        <header className="mb-8 border-b border-[#e3e5e2] pb-6">
          <p className="text-[11px] tracking-[.14em] uppercase text-[#4a654e] mb-2">Urushi Labs · Meeting report</p>
          <h1 className="text-[26px] leading-tight font-bold mb-2">{session.topic}</h1>
          <p className="text-[14px] text-[#737972]">
            {date ? `Meeting on ${date} · ` : ''}{(participants ?? []).map((p) => p.name).join(', ')}
          </p>
        </header>

        {report.safetyNote && (
          <div className="mb-6 rounded-xl bg-[#fdecea] px-4 py-3 text-[14px] leading-relaxed text-[#5f1412]">{report.safetyNote}</div>
        )}

        <Section title="What happened">
          <p className="text-[15px] leading-relaxed">{report.whatHappened}</p>
        </Section>

        {report.agreed.length > 0 && (
          <Section title="Agreements reached">
            <ul className="space-y-3 pl-5 list-disc">
              {report.agreed.map((a, i) => (
                <li key={i} className="text-[15px] leading-relaxed">
                  <span className="font-semibold">{a.title}</span>
                  <br />
                  <span className="text-[#4b4f4c]">{a.description}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {report.unresolved.length > 0 && (
          <Section title="Still unresolved">
            <ul className="space-y-3 pl-5 list-disc">
              {report.unresolved.map((u, i) => (
                <li key={i} className="text-[15px] leading-relaxed">
                  <span className="font-semibold">{u.title}</span>
                  <br />
                  <span className="text-[#4b4f4c]">{u.description}</span>
                  <br />
                  <span className="text-[#4a654e]">Suggested next step: {u.suggestedNextStep}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {report.participantActions.length > 0 && (
          <Section title="What each person should change">
            <div className="space-y-4">
              {report.participantActions.map((pa) => (
                <div key={pa.participantName}>
                  <p className="text-[15px] font-semibold mb-1">{pa.participantName}</p>
                  <ul className="pl-5 list-disc space-y-1">
                    {pa.actions.map((a, i) => (
                      <li key={i} className="text-[15px] leading-relaxed text-[#4b4f4c]">{a}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Section>
        )}

        {report.nextSteps.length > 0 && (
          <Section title="Next steps">
            <ol className="pl-5 list-decimal space-y-1.5">
              {report.nextSteps.map((s, i) => (
                <li key={i} className="text-[15px] leading-relaxed text-[#4b4f4c]">{s}</li>
              ))}
            </ol>
          </Section>
        )}

        <footer className="mt-10 border-t border-[#e3e5e2] pt-4 text-[12px] leading-relaxed text-[#737972]">
          Written by Urushi, an AI mediator, from what was said in the meeting. A communication aid, not legal, therapeutic or professional advice. urushilabs.com
        </footer>
      </div>
    </main>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-7 break-inside-avoid">
      <p className="text-[11px] tracking-[.14em] uppercase text-[#737972] mb-2">{title}</p>
      {children}
    </section>
  )
}
