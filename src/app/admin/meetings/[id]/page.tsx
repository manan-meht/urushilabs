import { redirect } from 'next/navigation'
import Link from 'next/link'
import { isAdminAuthenticated } from '@/lib/auth/adminSession'
import { getServiceClient } from '@/lib/db/client'

/**
 * Internal diagnostics view for Meeting Mediation (spec §40). Admin-only, never
 * linked from normal user-facing pages. Shows exactly what's needed to debug a
 * Recall integration issue during initial testing: session/provider IDs, status
 * history, participants, raw webhook events, and pipeline health.
 */
export default async function AdminMeetingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const authed = await isAdminAuthenticated()
  if (!authed) redirect('/admin')

  const { id: caseId } = await params
  const db = getServiceClient()

  const { data: caseRow } = await db
    .from('cases')
    .select('id, public_reference, topic, status, conversation_mode')
    .eq('id', caseId)
    .eq('conversation_mode', 'meeting_mediation')
    .single()

  if (!caseRow) redirect('/admin/cases')

  const { data: session } = await db
    .from('meeting_sessions')
    .select('*')
    .eq('case_id', caseId)
    .single()

  if (!session) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <p className="text-on-surface-variant">No meeting_sessions row found for this case.</p>
      </div>
    )
  }

  const [{ data: participants }, { data: events }, { data: interventions }, { data: usage }, { data: transcriptSample }] = await Promise.all([
    db.from('meeting_participants').select('*').eq('session_id', session.id).order('participant_index'),
    db.from('meeting_provider_events').select('*').eq('session_id', session.id).order('created_at', { ascending: false }).limit(50),
    db.from('meeting_interventions').select('*').eq('session_id', session.id).order('triggered_at', { ascending: false }).limit(20),
    db.from('meeting_usage').select('*').eq('session_id', session.id).single(),
    db.from('meeting_transcript_segments').select('sequence_number, speaker_name, role, content, created_at').eq('session_id', session.id).order('sequence_number', { ascending: false }).limit(20),
  ])

  const lastEvent = events?.[0]
  const errorEvents = (events ?? []).filter((e) => e.error_message)

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/admin/cases" className="text-primary text-label-sm font-medium flex items-center gap-1">
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          All cases
        </Link>
        <span className="text-outline-variant">·</span>
        <h1 className="font-headline-md text-on-surface">Meeting Mediation diagnostics</h1>
      </div>

      <section className="bg-white border border-outline-variant rounded-xl p-4 grid grid-cols-2 gap-x-6 gap-y-2 text-label-sm">
        <Field label="Urushi session ID" value={session.id} mono />
        <Field label="Case reference" value={caseRow.public_reference} mono />
        <Field label="Status" value={session.status} />
        <Field label="Bot provider" value={session.bot_provider} />
        <Field label="Meeting platform" value={session.meeting_platform ?? '—'} />
        <Field label="Meeting URL" value={session.meeting_url ?? '—'} mono />
        <Field label="Provider bot ID" value={session.provider_bot_id ?? '—'} mono />
        <Field label="Provider meeting ID" value={session.provider_meeting_id ?? '—'} mono />
        <Field label="Requested at" value={session.requested_at ?? '—'} />
        <Field label="Joined at" value={session.joined_at ?? '—'} />
        <Field label="Ended at" value={session.ended_at ?? '—'} />
        <Field label="Failure reason" value={session.failure_reason ?? '—'} />
        <Field label="Intervention count" value={String((interventions ?? []).length)} />
        <Field label="Last provider event" value={lastEvent ? `${lastEvent.event_type} @ ${lastEvent.created_at}` : '—'} />
        <Field label="Webhook errors" value={String(errorEvents.length)} />
      </section>

      {usage && (
        <section className="bg-white border border-outline-variant rounded-xl p-4">
          <h2 className="font-label-md font-semibold text-on-surface mb-2">Usage / cost accounting</h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-label-sm">
            <Field label="Meeting duration (s)" value={String(usage.meeting_duration_seconds ?? '—')} />
            <Field label="Transcript segments" value={String(usage.transcript_segment_count)} />
            <Field label="OpenAI input tokens" value={String(usage.openai_input_tokens)} />
            <Field label="OpenAI output tokens" value={String(usage.openai_output_tokens)} />
            <Field label="Generated audio (s)" value={String(usage.generated_audio_seconds)} />
            <Field label="Estimated cost (USD)" value={usage.estimated_total_cost_usd != null ? `$${usage.estimated_total_cost_usd}` : 'not computed'} />
          </div>
        </section>
      )}

      <section className="bg-white border border-outline-variant rounded-xl p-4">
        <h2 className="font-label-md font-semibold text-on-surface mb-2">Participants</h2>
        <table className="w-full text-label-sm">
          <thead>
            <tr className="text-left text-on-surface-variant">
              <th className="pb-1">Name</th>
              <th className="pb-1">Email</th>
              <th className="pb-1">Initiator</th>
              <th className="pb-1">Consented</th>
              <th className="pb-1">Context</th>
              <th className="pb-1">Provider participant ID</th>
            </tr>
          </thead>
          <tbody>
            {(participants ?? []).map((p) => (
              <tr key={p.id} className="border-t border-outline-variant/40">
                <td className="py-1">{p.name}</td>
                <td className="py-1">{p.email ?? '—'}</td>
                <td className="py-1">{p.is_initiator ? 'yes' : 'no'}</td>
                <td className="py-1">{p.consented_at ? 'yes' : 'no'}</td>
                <td className="py-1">{p.context_submitted_at ? 'yes' : 'no'}</td>
                <td className="py-1 font-mono">{p.provider_participant_id ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="bg-white border border-outline-variant rounded-xl p-4">
        <h2 className="font-label-md font-semibold text-on-surface mb-2">Recent interventions</h2>
        {(interventions ?? []).length === 0 ? (
          <p className="text-label-sm text-on-surface-variant">None yet.</p>
        ) : (
          <ul className="space-y-2">
            {(interventions ?? []).map((i) => (
              <li key={i.id} className="text-label-sm border-t border-outline-variant/40 pt-2">
                <span className="font-mono font-semibold">{i.action}</span> — {i.reasoning}
                {i.spoken_text && <p className="text-on-surface-variant mt-0.5">&ldquo;{i.spoken_text}&rdquo;</p>}
                <p className="text-outline text-[11px]">{i.triggered_at}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-white border border-outline-variant rounded-xl p-4">
        <h2 className="font-label-md font-semibold text-on-surface mb-2">Recent transcript segments</h2>
        {(transcriptSample ?? []).length === 0 ? (
          <p className="text-label-sm text-on-surface-variant">None ingested yet.</p>
        ) : (
          <ul className="space-y-1">
            {(transcriptSample ?? []).map((t) => (
              <li key={t.sequence_number} className="text-label-sm border-t border-outline-variant/40 pt-1">
                <span className="font-semibold">{t.speaker_name ?? t.role}:</span> {t.content}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-white border border-outline-variant rounded-xl p-4">
        <h2 className="font-label-md font-semibold text-on-surface mb-2">Webhook events</h2>
        {(events ?? []).length === 0 ? (
          <p className="text-label-sm text-on-surface-variant">None received yet.</p>
        ) : (
          <ul className="space-y-1">
            {(events ?? []).map((e) => (
              <li key={e.id} className="text-label-sm border-t border-outline-variant/40 pt-1 flex items-center justify-between gap-2">
                <span className="font-mono">{e.event_type}</span>
                <span className="text-outline text-[11px]">{e.created_at}</span>
                {e.error_message && <span className="text-error text-[11px]">{e.error_message}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-outline text-[11px] uppercase tracking-wide">{label}</p>
      <p className={`text-on-surface ${mono ? 'font-mono text-[12px] break-all' : ''}`}>{value}</p>
    </div>
  )
}
