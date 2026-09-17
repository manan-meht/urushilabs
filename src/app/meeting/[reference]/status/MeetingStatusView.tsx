'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { DbMeetingParticipant, DbMeetingSession, MeetingFinalReport, MeetingStatus } from '@/lib/db/types'

type ParticipantRow = Pick<DbMeetingParticipant, 'id' | 'participant_index' | 'name' | 'is_initiator' | 'context_submitted_at' | 'consented_at' | 'invited_at'>

interface Props {
  sessionId: string
  caseReference: string
  session: DbMeetingSession
  participants: ParticipantRow[]
}

const STATUS_LABELS: Record<MeetingStatus, string> = {
  setup: 'Setting up',
  awaiting_preparation: 'Awaiting participant preparation',
  ready: 'Ready',
  bot_requested: 'Requesting Urushi to join',
  joining: 'Joining the meeting',
  waiting_room: 'Waiting to be admitted',
  in_meeting: 'In the meeting',
  ended: 'Meeting ended',
  generating_report: 'Generating report',
  completed: 'Complete',
  failed: 'Failed to join',
  disconnected: 'Disconnected',
  cancelled: 'Cancelled',
}

const TERMINAL_STATUSES: MeetingStatus[] = ['completed', 'cancelled', 'failed']

interface StatusResponse {
  session: {
    id: string
    status: MeetingStatus
    topic: string
    meetingPlatform: 'google_meet' | 'zoom' | null
    meetingUrl: string | null
    scheduledStartAt: string | null
    timezone: string | null
    startNow: boolean
    failureReason: string | null
    finalReport: MeetingFinalReport | null
  }
  participants: Array<{ id: string; name: string; isInitiator: boolean; contextSubmitted: boolean; consented: boolean; invited: boolean }>
}

export function MeetingStatusView({ sessionId, caseReference, session: initialSession, participants: initialParticipants }: Props) {
  const router = useRouter()
  const [data, setData] = useState<StatusResponse>({
    session: {
      id: initialSession.id,
      status: initialSession.status,
      topic: initialSession.topic,
      meetingPlatform: initialSession.meeting_platform,
      meetingUrl: initialSession.meeting_url,
      scheduledStartAt: initialSession.scheduled_start_at,
      timezone: initialSession.timezone,
      startNow: initialSession.start_now,
      failureReason: initialSession.failure_reason,
      finalReport: initialSession.final_report,
    },
    participants: initialParticipants.map((p) => ({
      id: p.id,
      name: p.name,
      isInitiator: p.is_initiator,
      contextSubmitted: Boolean(p.context_submitted_at),
      consented: Boolean(p.consented_at),
      invited: Boolean(p.invited_at),
    })),
  })

  const [meetingUrl, setMeetingUrl] = useState(initialSession.meeting_url ?? '')
  const [startNow, setStartNow] = useState(initialSession.start_now)
  const [scheduledDate, setScheduledDate] = useState('')
  const [scheduledTime, setScheduledTime] = useState('')
  const [timezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [detailsError, setDetailsError] = useState('')
  const [savingDetails, setSavingDetails] = useState(false)
  const [starting, setStarting] = useState(false)
  const [generatingReport, setGeneratingReport] = useState(false)
  const [actionError, setActionError] = useState('')
  const [copiedLinkFor, setCopiedLinkFor] = useState<string | null>(null)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    async function poll() {
      try {
        const res = await fetch(`/api/meeting/sessions/${sessionId}/status`)
        if (!res.ok) return
        const json = await res.json() as StatusResponse
        setData(json)
        if (TERMINAL_STATUSES.includes(json.session.status)) {
          if (pollRef.current) clearInterval(pollRef.current)
        }
      } catch {
        // best-effort polling
      }
    }
    void poll()
    if (!TERMINAL_STATUSES.includes(data.session.status)) {
      pollRef.current = setInterval(() => void poll(), 5000)
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  async function saveDetails(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setDetailsError('')
    setSavingDetails(true)
    try {
      const scheduledStartAt = !startNow && scheduledDate && scheduledTime
        ? new Date(`${scheduledDate}T${scheduledTime}`).toISOString()
        : undefined

      const res = await fetch(`/api/meeting/sessions/${sessionId}/details`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingUrl, scheduledStartAt, timezone, startNow }),
      })
      const json = await res.json() as { error?: string; errors?: Record<string, string[]> }
      if (!res.ok) {
        setDetailsError(json.errors?.['meetingUrl']?.[0] ?? json.error ?? 'Please enter a valid Google Meet or Zoom link.')
        return
      }
      setData((prev) => ({ ...prev, session: { ...prev.session, status: 'ready', meetingUrl, startNow } }))
    } catch {
      setDetailsError('A network error occurred. Please try again.')
    } finally {
      setSavingDetails(false)
    }
  }

  async function startNowAction() {
    setActionError('')
    setStarting(true)
    try {
      const res = await fetch(`/api/meeting/sessions/${sessionId}/join`, { method: 'POST' })
      const json = await res.json() as { error?: string; message?: string; status?: MeetingStatus }
      if (!res.ok) {
        setActionError(json.message ?? json.error ?? "Urushi couldn't join the meeting.")
        return
      }
      setData((prev) => ({ ...prev, session: { ...prev.session, status: json.status ?? 'joining' } }))
    } catch {
      setActionError('A network error occurred. Please try again.')
    } finally {
      setStarting(false)
    }
  }

  async function generateReport() {
    setActionError('')
    setGeneratingReport(true)
    try {
      const res = await fetch(`/api/meeting/sessions/${sessionId}/complete`, { method: 'POST' })
      const json = await res.json() as { error?: string; report?: MeetingFinalReport }
      if (!res.ok || !json.report) {
        setActionError(json.error ?? 'Could not generate the report. Please try again.')
        return
      }
      setData((prev) => ({ ...prev, session: { ...prev.session, status: 'completed', finalReport: json.report! } }))
    } catch {
      setActionError('A network error occurred. Please try again.')
    } finally {
      setGeneratingReport(false)
    }
  }

  async function cancelMediation() {
    if (!confirm('Cancel this Meeting Mediation? This cannot be undone.')) return
    await fetch(`/api/meeting/sessions/${sessionId}/cancel`, { method: 'POST' })
    router.push('/dashboard')
  }

  async function copyParticipantLink(participantId: string) {
    try {
      const res = await fetch(`/api/meeting/sessions/${sessionId}/participants/${participantId}/link`, { method: 'POST' })
      const json = await res.json() as { link?: string; error?: string }
      if (!res.ok || !json.link) return
      await navigator.clipboard.writeText(json.link)
      setCopiedLinkFor(participantId)
      setTimeout(() => setCopiedLinkFor(null), 2000)
    } catch {
      // best-effort
    }
  }

  async function copyMeetingLink() {
    if (!data.session.meetingUrl) return
    await navigator.clipboard.writeText(data.session.meetingUrl)
  }

  const { session, participants } = data
  const needsDetails = !session.meetingUrl
  const canStartNow = session.status === 'ready'
  const canCancel = !TERMINAL_STATUSES.includes(session.status)

  return (
    <div className="px-margin-mobile pt-stack-md pb-stack-lg max-w-xl mx-auto">
      <div className="text-center mb-6">
        <div className="w-14 h-14 bg-primary-container rounded-full flex items-center justify-center mx-auto mb-3">
          <span className="material-symbols-outlined text-white text-[28px]" style={{ fontVariationSettings: "'FILL' 1" }}>video_call</span>
        </div>
        <h1 className="font-headline-xl-mobile text-headline-xl-mobile text-on-surface mb-1">Meeting Mediation</h1>
        <p className="font-body-lg text-on-surface-variant">{session.topic}</p>
        {session.scheduledStartAt && (
          <p className="font-label-sm text-outline mt-1">
            {new Date(session.scheduledStartAt).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' })}
            {session.meetingPlatform && ` · ${session.meetingPlatform === 'google_meet' ? 'Google Meet' : 'Zoom'}`}
          </p>
        )}
      </div>

      {session.failureReason && (
        <div className="bg-error-container text-on-error-container p-4 rounded-xl font-body-md mb-4" role="alert">
          {session.failureReason}
        </div>
      )}

      <div className="bg-surface-container-low rounded-xl border border-outline-variant/40 p-5 mb-6 text-center">
        <p className="font-label-sm text-outline uppercase tracking-widest mb-1">Urushi status</p>
        <p className="font-headline-sm text-on-surface">{STATUS_LABELS[session.status]}</p>
      </div>

      {session.status === 'completed' && session.finalReport ? (
        <MeetingReportSection report={session.finalReport} />
      ) : (
        <>
          <section className="mb-6">
            <p className="font-label-sm text-outline uppercase tracking-widest mb-3">Participants</p>
            <div className="space-y-2">
              {participants.map((p) => (
                <div key={p.id} className="flex items-center justify-between bg-surface-container-lowest border border-outline-variant/40 rounded-xl p-3">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[18px]" style={{ color: p.contextSubmitted && p.consented ? '#386664' : '#9aa39f' }}>
                      {p.contextSubmitted && p.consented ? 'check_circle' : 'radio_button_unchecked'}
                    </span>
                    <span className="font-body-md text-on-surface">{p.name}{p.isInitiator ? ' (you)' : ''}</span>
                  </div>
                  <span className="font-label-sm text-on-surface-variant">
                    {p.isInitiator ? '' : !p.consented ? 'invited' : !p.contextSubmitted ? 'consented' : 'context submitted'}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2 mt-3">
              {participants.filter((p) => !p.isInitiator).map((p) => (
                <button
                  key={p.id}
                  onClick={() => void copyParticipantLink(p.id)}
                  className="text-label-sm px-3 py-2 rounded-lg border border-outline-variant text-on-surface-variant hover:border-primary hover:text-primary transition-colors"
                >
                  {copiedLinkFor === p.id ? 'Copied!' : `Copy ${p.name}'s link`}
                </button>
              ))}
            </div>
          </section>

          {needsDetails ? (
            <section className="mb-6">
              <p className="font-label-sm text-outline uppercase tracking-widest mb-3">Where will the conversation happen?</p>
              <form onSubmit={saveDetails} className="space-y-3" noValidate>
                <input
                  type="url"
                  required
                  value={meetingUrl}
                  onChange={(e) => setMeetingUrl(e.target.value)}
                  placeholder="https://meet.google.com/... or https://zoom.us/j/..."
                  className="w-full h-14 px-4 bg-white border border-outline-variant rounded-xl focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-all placeholder:text-outline/50"
                />
                {detailsError && <p className="text-error text-label-md" role="alert">{detailsError}</p>}

                <label className="flex items-center gap-2 font-body-md text-on-surface">
                  <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} className="w-5 h-5 rounded accent-primary" />
                  Start Urushi now (meeting already running)
                </label>

                {!startNow && (
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="date"
                      value={scheduledDate}
                      onChange={(e) => setScheduledDate(e.target.value)}
                      className="h-12 px-3 bg-white border border-outline-variant rounded-xl outline-none"
                    />
                    <input
                      type="time"
                      value={scheduledTime}
                      onChange={(e) => setScheduledTime(e.target.value)}
                      className="h-12 px-3 bg-white border border-outline-variant rounded-xl outline-none"
                    />
                  </div>
                )}

                <button
                  type="submit"
                  disabled={savingDetails}
                  className="w-full h-14 bg-primary text-on-primary rounded-xl font-bold text-body-md hover:opacity-90 transition-all disabled:opacity-60"
                >
                  {savingDetails ? 'Saving…' : 'Save meeting details'}
                </button>
              </form>
            </section>
          ) : (
            <section className="mb-6 flex flex-wrap gap-2">
              <button onClick={() => void copyMeetingLink()} className="text-label-sm px-3 py-2 rounded-lg border border-outline-variant text-on-surface-variant hover:border-primary hover:text-primary transition-colors">
                Copy meeting link
              </button>
            </section>
          )}

          {actionError && (
            <div className="bg-error-container text-on-error-container p-4 rounded-xl font-body-md mb-4" role="alert">{actionError}</div>
          )}

          <div className="space-y-3">
            {session.status === 'ended' && (
              <button
                onClick={() => void generateReport()}
                disabled={generatingReport}
                className="w-full h-14 bg-primary text-on-primary rounded-xl font-bold text-body-md hover:opacity-90 transition-all disabled:opacity-60"
              >
                {generatingReport ? 'Generating report…' : 'Generate report'}
              </button>
            )}
            {canStartNow && (
              <button
                onClick={() => void startNowAction()}
                disabled={starting}
                className="w-full h-14 bg-primary text-on-primary rounded-xl font-bold text-body-md hover:opacity-90 transition-all disabled:opacity-60"
              >
                {starting ? 'Starting…' : 'Start Urushi now'}
              </button>
            )}
            {canCancel && (
              <button
                onClick={() => void cancelMediation()}
                className="w-full h-12 text-error font-label-md hover:opacity-80 transition-colors"
              >
                Cancel mediation
              </button>
            )}
          </div>
        </>
      )}

      <p className="text-center text-label-sm text-outline mt-6">Case reference: {caseReference}</p>
    </div>
  )
}

function MeetingReportSection({ report }: { report: MeetingFinalReport }) {
  return (
    <div className="space-y-6">
      {report.safetyNote && (
        <div className="bg-error-container/40 border border-error-container rounded-xl p-4 flex items-start gap-2">
          <span className="material-symbols-outlined text-error text-[20px] shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>warning</span>
          <div>
            <p className="font-body-md text-on-surface">{report.safetyNote}</p>
            <a href="/safety" className="text-label-sm text-secondary underline mt-1 inline-block">Visit our safety page →</a>
          </div>
        </div>
      )}

      <section className="bg-surface-container-low rounded-xl border border-outline-variant/40 p-5">
        <p className="font-label-sm text-outline uppercase tracking-widest mb-2">What happened</p>
        <p className="font-body-md text-on-surface leading-relaxed">{report.whatHappened}</p>
      </section>

      {report.agreed.length > 0 && (
        <section className="bg-surface-container-low rounded-xl border border-outline-variant/40 p-5">
          <p className="font-label-sm text-outline uppercase tracking-widest mb-3">Agreements reached</p>
          <ul className="space-y-3">
            {report.agreed.map((item, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="material-symbols-outlined text-primary text-[20px] shrink-0 mt-0.5" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                <div>
                  <p className="font-label-md font-semibold text-on-surface">{item.title}</p>
                  <p className="font-body-md text-on-surface-variant">{item.description}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.unresolved.length > 0 && (
        <section className="bg-surface-container-low rounded-xl border border-outline-variant/40 p-5">
          <p className="font-label-sm text-outline uppercase tracking-widest mb-3">Still unresolved</p>
          <ul className="space-y-3">
            {report.unresolved.map((item, i) => (
              <li key={i}>
                <p className="font-label-md font-semibold text-on-surface">{item.title}</p>
                <p className="font-body-md text-on-surface-variant">{item.description}</p>
                <p className="font-body-md text-secondary mt-1">Suggested next step: {item.suggestedNextStep}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.participantActions.length > 0 && (
        <section className="bg-surface-container-low rounded-xl border border-outline-variant/40 p-5">
          <p className="font-label-sm text-outline uppercase tracking-widest mb-3">What each person should change</p>
          <div className="space-y-4">
            {report.participantActions.map((pa) => (
              <div key={pa.participantName}>
                <p className="font-label-md font-semibold text-on-surface mb-1">{pa.participantName}</p>
                <ul className="list-disc list-inside space-y-1">
                  {pa.actions.map((a, i) => (
                    <li key={i} className="font-body-md text-on-surface-variant">{a}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      {report.nextSteps.length > 0 && (
        <section className="bg-surface-container-low rounded-xl border border-outline-variant/40 p-5">
          <p className="font-label-sm text-outline uppercase tracking-widest mb-3">Next steps</p>
          <ol className="list-decimal list-inside space-y-1.5">
            {report.nextSteps.map((step, i) => (
              <li key={i} className="font-body-md text-on-surface-variant">{step}</li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}
