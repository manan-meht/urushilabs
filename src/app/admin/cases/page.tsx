import { redirect } from 'next/navigation'
import { isAdminAuthenticated } from '@/lib/auth/adminSession'
import { getServiceClient } from '@/lib/db/client'
import Link from 'next/link'

const STATUS_LABEL: Record<string, string> = {
  awaiting_initiator: 'Awaiting initiator',
  awaiting_recipient: 'Awaiting recipient',
  ready_for_analysis: 'Ready for analysis',
  analysing: 'Analysing',
  report_ready: 'Report ready',
  needs_safety_review: 'Safety review needed',
}

const STATUS_COLOR: Record<string, string> = {
  awaiting_initiator: 'bg-outline-variant text-on-surface-variant',
  awaiting_recipient: 'bg-secondary-container text-on-secondary-container',
  ready_for_analysis: 'bg-tertiary-container text-on-tertiary-container',
  analysing: 'bg-tertiary-container text-on-tertiary-container',
  report_ready: 'bg-primary-container text-on-primary-container',
  needs_safety_review: 'bg-error-container text-on-error-container',
}

export default async function AdminCasesPage() {
  const authed = await isAdminAuthenticated()
  if (!authed) redirect('/admin')

  const db = getServiceClient()
  const { data: cases } = await db
    .from('cases')
    .select('id, public_reference, topic, status, initiator_name, recipient_name, created_at, conversation_mode')
    .order('created_at', { ascending: false })

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-headline-md text-on-surface">All Cases</h1>
        <span className="text-label-sm text-on-surface-variant">{cases?.length ?? 0} cases</span>
      </div>

      <div className="flex flex-col gap-3">
        {cases?.map((c) => (
          <Link
            key={c.id}
            href={c.conversation_mode === 'meeting_mediation' ? `/admin/meetings/${c.id}` : `/admin/cases/${c.id}`}
            className="bg-white border border-outline-variant rounded-xl p-4 flex flex-col gap-2 hover:border-primary transition-colors"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-label-md text-on-surface font-semibold">{c.topic}</p>
                <p className="text-label-sm text-on-surface-variant">{c.initiator_name} → {c.recipient_name}</p>
              </div>
              <span className={`text-label-sm px-2 py-1 rounded-full font-medium shrink-0 ${STATUS_COLOR[c.status] ?? 'bg-outline-variant text-on-surface-variant'}`}>
                {STATUS_LABEL[c.status] ?? c.status}
              </span>
            </div>
            <p className="text-label-sm text-outline font-mono">{c.public_reference} · {new Date(c.created_at as string).toLocaleDateString()}</p>
          </Link>
        ))}

        {!cases?.length && (
          <p className="text-on-surface-variant text-center py-12">No cases yet.</p>
        )}
      </div>
    </div>
  )
}
