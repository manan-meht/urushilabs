'use client'

import { useRouter } from 'next/navigation'

const STATUS_LABEL: Record<string, string> = {
  awaiting_initiator: 'Setting up',
  awaiting_recipient: 'Waiting for other party',
  ready_for_analysis: 'Processing',
  analysing: 'Generating report',
  report_ready: 'Report ready',
  needs_safety_review: 'Under review',
}

const STATUS_COLOR: Record<string, string> = {
  awaiting_initiator: 'bg-outline-variant/40 text-on-surface-variant',
  awaiting_recipient: 'bg-secondary-container text-on-secondary-container',
  ready_for_analysis: 'bg-tertiary-container/60 text-on-tertiary-container',
  analysing: 'bg-tertiary-container/60 text-on-tertiary-container',
  report_ready: 'bg-primary-container text-on-primary-container',
  needs_safety_review: 'bg-error-container text-on-error-container',
}

const STATUS_ICON: Record<string, string> = {
  awaiting_initiator: 'pending',
  awaiting_recipient: 'hourglass_empty',
  ready_for_analysis: 'sync',
  analysing: 'psychology',
  report_ready: 'check_circle',
  needs_safety_review: 'warning',
}

export interface CaseRow {
  id: string
  public_reference: string
  topic: string
  status: string
  initiator_name: string
  recipient_name: string
  created_at: string
  conversation_mode: string
  userRole: 'initiator' | 'recipient'
}

export function CaseList({ cases }: { cases: CaseRow[] }) {
  const router = useRouter()

  async function openCase(caseId: string) {
    const c = cases.find((x) => x.id === caseId)

    // Room and Meeting Mediation cases authenticate directly via the Supabase
    // user session on their own pages — they don't have a `participants` row
    // (that table is classic invited/together-mode only), so the cg_session
    // restore flow below would 404 for them. Their landing pages self-redirect
    // to the correct stage/status internally.
    if (c?.conversation_mode === 'room') {
      router.push(`/room/${c.public_reference}/ready`)
      return
    }
    if (c?.conversation_mode === 'meeting_mediation') {
      router.push(`/meeting/${c.public_reference}/status`)
      return
    }

    const res = await fetch(`/api/cases/${caseId}/session`, { method: 'POST' })
    if (res.ok) {
      const { destination } = await res.json() as { destination: string }
      router.push(destination)
    } else {
      // Fallback: navigate anyway and let the page handle it
      if (c) {
        const isReady = ['report_ready', 'needs_safety_review'].includes(c.status)
        const isActive = ['awaiting_recipient', 'ready_for_analysis', 'analysing'].includes(c.status)
        router.push(
          isReady
            ? `/case/${c.public_reference}/report`
            : isActive
              ? `/case/${c.public_reference}/waiting`
              : `/case/${c.public_reference}/intake`
        )
      }
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {cases.map((c) => (
        <button
          key={c.id}
          onClick={() => void openCase(c.id)}
          className="bg-white border border-outline-variant/40 rounded-2xl p-5 flex items-start gap-4 hover:border-primary/40 hover:shadow-sm transition-all text-left w-full"
        >
          <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${STATUS_COLOR[c.status] ?? 'bg-outline-variant/40 text-on-surface-variant'}`}>
            <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>
              {STATUS_ICON[c.status] ?? 'chat'}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-label-md text-on-surface font-semibold truncate">{c.topic}</p>
            <p className="text-label-sm text-on-surface-variant mt-0.5">
              With {c.userRole === 'initiator' ? c.recipient_name : c.initiator_name} · {new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
          </div>
          <span className={`text-label-sm px-2.5 py-1 rounded-full font-medium shrink-0 ${STATUS_COLOR[c.status] ?? ''}`}>
            {STATUS_LABEL[c.status] ?? c.status}
          </span>
        </button>
      ))}
    </div>
  )
}
