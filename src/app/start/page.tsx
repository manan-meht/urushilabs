import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { SiteHeader, SiteFooter } from '@/components/SiteHeader'
import { ModeSelector } from './ModeSelector'
import { getUser } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { getOrCreateCredits } from '@/lib/db/credits'
import { extractFirstName } from '@/lib/invitation'
import { isLiveMediationEnabled, isMeetingMediationEnabled } from '@/lib/featureFlags'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Start a Conversation — Urushi Labs',
  robots: { index: false },
}

export default async function StartPage() {
  const user = await getUser()
  if (!user) redirect('/auth?next=/start')

  const credits = await getOrCreateCredits(user.id)
  const hasCredits = credits.rooms_available > 0

  const fullName: string =
    (user.user_metadata?.['full_name'] as string | undefined) ??
    user.email ??
    'you'
  const firstName = extractFirstName(fullName)
  const userEmail = user.email ?? null
  const liveMediationEnabled = isLiveMediationEnabled(userEmail)
  const meetingMediationEnabled = isMeetingMediationEnabled(userEmail)

  let existingCases: Array<{ reference: string; topic: string }> = []
  if (liveMediationEnabled) {
    const db = getServiceClient()
    const { data } = await db
      .from('cases')
      .select('public_reference, topic')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10)
    existingCases = (data ?? []).map((c) => ({ reference: c.public_reference, topic: c.topic }))
  }

  return (
    <div className="flex flex-col min-h-screen">
      <SiteHeader exitHref="/" userEmail={user.email} logoHref="/" />
      <main className="flex-grow">
        <div className="px-margin-mobile pt-stack-md pb-stack-sm md:max-w-xl mx-auto">
          <h1 className="font-headline-xl-mobile text-headline-xl-mobile text-on-surface mb-2 text-center">
            Start a conversation
          </h1>
          <p className="text-on-surface-variant font-body-md text-center">
            Choose how you&apos;d like to have this conversation.
          </p>
        </div>

        {hasCredits ? (
          <ModeSelector
            userFirstName={firstName}
            userEmail={userEmail}
            roomsRemaining={credits.rooms_available}
            liveMediationEnabled={liveMediationEnabled}
            meetingMediationEnabled={meetingMediationEnabled}
            existingCases={existingCases}
          />
        ) : (
          <div className="max-w-md mx-auto px-margin-mobile py-stack-md text-center">
            <div className="bg-surface-container-low rounded-2xl border border-outline-variant p-8 flex flex-col items-center gap-4">
              <span className="material-symbols-outlined text-[48px] text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>meeting_room</span>
              <h2 className="font-headline-md text-on-surface">No conversation rooms remaining</h2>
              <p className="text-on-surface-variant font-body-md">
                You have used all your rooms. Purchase a plan to start more conversations.
              </p>
              <Link
                href="/pricing"
                className="w-full py-4 bg-primary text-on-primary rounded-xl font-bold text-body-lg shadow-md text-center block"
              >
                View plans
              </Link>
              <div className="flex items-center justify-center gap-4">
                <Link href="/dashboard" className="text-label-sm text-on-surface-variant hover:text-on-surface transition-colors">
                  Back to my cases
                </Link>
                <span className="text-outline-variant">·</span>
                <Link href="/" className="text-label-sm text-on-surface-variant hover:text-on-surface transition-colors">
                  Back to home
                </Link>
              </div>
            </div>
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  )
}
