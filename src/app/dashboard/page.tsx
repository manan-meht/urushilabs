import { redirect } from 'next/navigation'
import { getUser } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { getOrCreateCredits } from '@/lib/db/credits'
import { SiteHeader, SiteFooter } from '@/components/SiteHeader'
import Link from 'next/link'
import { CaseList } from './CaseList'

export default async function DashboardPage() {
  const user = await getUser()
  if (!user) redirect('/auth')

  const db = getServiceClient()

  const [credits, initiatedResult, participantResult] = await Promise.all([
    getOrCreateCredits(user.id),
    db
      .from('cases')
      .select('id, public_reference, topic, status, initiator_name, recipient_name, created_at, conversation_mode')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
    db
      .from('participants')
      .select('case_id, cases(id, public_reference, topic, status, initiator_name, recipient_name, created_at, conversation_mode)')
      .eq('user_id', user.id),
  ])

  // Merge initiated + recipient cases, deduplicate by id
  type RawCase = { id: string; public_reference: string; topic: string; status: string; initiator_name: string; recipient_name: string; created_at: string; conversation_mode: string }
  type CaseRow = RawCase & { userRole: 'initiator' | 'recipient' }

  const initiatedIds = new Set((initiatedResult.data ?? []).map((c) => c.id))
  const seenIds = new Set<string>()
  const allCases: CaseRow[] = []

  for (const c of (initiatedResult.data ?? [])) {
    seenIds.add(c.id)
    allCases.push({ ...(c as unknown as RawCase), userRole: 'initiator' })
  }
  for (const p of (participantResult.data ?? [])) {
    const c = p.cases as unknown as RawCase | null
    if (c && !seenIds.has(c.id)) {
      seenIds.add(c.id)
      allCases.push({ ...c, userRole: initiatedIds.has(c.id) ? 'initiator' : 'recipient' })
    }
  }
  allCases.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  const cases = allCases

  const displayName = user.user_metadata?.full_name ?? user.email?.split('@')[0] ?? 'there'

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <SiteHeader userEmail={user?.email} logoHref="/" />
      <main className="flex-1 w-full max-w-2xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="font-headline-md text-on-surface">Hi, {displayName}</h1>
            <p className="text-on-surface-variant font-body-md">Your conversations</p>
          </div>
          <Link
            href="/start"
            className="flex items-center gap-2 bg-primary text-white px-5 py-3 rounded-xl font-label-md shadow-sm hover:bg-on-primary-fixed-variant transition-all active:scale-95"
          >
            <span className="material-symbols-outlined text-[20px]">add</span>
            New
          </Link>
        </div>

        {/* Credits bar */}
        <div className="flex items-center justify-between bg-surface-container-low border border-outline-variant rounded-xl px-4 py-3 mb-6">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-primary text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>account_balance_wallet</span>
            <div>
              <p className="text-label-sm text-on-surface font-medium">
                {credits.rooms_available} room{credits.rooms_available !== 1 ? 's' : ''} available
                {credits.follow_ups_available > 0 && ` · ${credits.follow_ups_available} follow-ups`}
              </p>
              <p className="text-label-sm text-on-surface-variant">{credits.total_rooms_created} conversation{credits.total_rooms_created !== 1 ? 's' : ''} started</p>
            </div>
          </div>
          {credits.rooms_available === 0 && (
            <Link href="/pricing" className="text-label-sm text-primary font-medium">
              Buy more →
            </Link>
          )}
        </div>

        {/* Cases list */}
        {cases && cases.length > 0 ? (
          <CaseList cases={cases} />
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-center gap-4">
            <div className="w-16 h-16 bg-primary-container/30 rounded-full flex items-center justify-center">
              <span className="material-symbols-outlined text-primary text-[32px]" style={{ fontVariationSettings: "'FILL' 1" }}>chat</span>
            </div>
            <h2 className="font-headline-sm text-on-surface">No conversations yet</h2>
            <p className="text-on-surface-variant font-body-md max-w-xs">
              Start your first conversation to begin working through a disagreement constructively.
            </p>
            <Link
              href="/start"
              className="mt-2 bg-primary text-white px-6 py-3 rounded-xl font-bold shadow-sm hover:bg-on-primary-fixed-variant transition-all active:scale-95"
            >
              Start a conversation
            </Link>
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  )
}
