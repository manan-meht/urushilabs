'use client'

import Link from 'next/link'
import type { RoomFinalReport } from '@/lib/db/types'

interface Props {
  report: RoomFinalReport | null
}

export function RoomSummaryView({ report }: Props) {
  if (!report) {
    return (
      <div className="px-margin-mobile pt-stack-lg pb-stack-lg max-w-lg mx-auto text-center">
        <p className="font-body-md text-on-surface-variant">Generating your summary…</p>
      </div>
    )
  }

  return (
    <div className="px-margin-mobile pt-stack-md pb-stack-lg max-w-2xl mx-auto space-y-6">
      <div className="text-center">
        <div className="w-14 h-14 bg-tertiary-container rounded-full flex items-center justify-center mx-auto mb-4">
          <span className="material-symbols-outlined text-white text-[28px]" style={{ fontVariationSettings: "'FILL' 1" }}>task_alt</span>
        </div>
        <h1 className="font-headline-xl-mobile text-headline-xl-mobile text-on-surface">Mediation summary</h1>
      </div>

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
          <p className="font-label-sm text-outline uppercase tracking-widest mb-3">What you agreed</p>
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
          <p className="font-label-sm text-outline uppercase tracking-widest mb-3">What each person should do</p>
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

      <div className="text-center pt-4 space-y-3">
        <p className="font-body-md text-on-surface-variant">You can come back to Urushi any time you need to talk again.</p>
        <Link
          href="/start"
          className="inline-block px-8 py-3.5 bg-tertiary text-white rounded-xl font-bold text-body-md hover:opacity-90 transition-all"
        >
          Start a new conversation
        </Link>
      </div>
    </div>
  )
}
