import type { Metadata } from 'next'
import { SiteHeader, SiteFooter } from '@/components/SiteHeader'
import { requireMeetingParticipantByToken, isAccessError } from '@/lib/meeting/getSession'
import { MeetingPrepareView } from './MeetingPrepareView'

export const metadata: Metadata = {
  title: 'Prepare for your conversation — Urushi Labs',
  robots: { index: false },
}

export default async function MeetingPreparePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  const access = await requireMeetingParticipantByToken(token)

  return (
    <div className="flex flex-col min-h-screen">
      <SiteHeader logoHref="/" />
      <main className="flex-grow">
        {isAccessError(access) ? (
          <div className="px-margin-mobile pt-stack-lg pb-stack-lg max-w-md mx-auto text-center">
            <h1 className="font-headline-lg text-on-surface mb-2">Link unavailable</h1>
            <p className="font-body-md text-on-surface-variant">{access.error}</p>
          </div>
        ) : (
          <MeetingPrepareView
            token={token}
            participantName={access.participant.name}
            topic={access.session.topic}
            contextSummary={access.session.context_summary}
            alreadyConsented={Boolean(access.participant.consented_at)}
            alreadySubmittedContext={Boolean(access.participant.context_submitted_at)}
          />
        )}
      </main>
      <SiteFooter />
    </div>
  )
}
