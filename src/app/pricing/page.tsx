import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getUser } from '@/lib/supabase/server'
import { getOrCreateCredits } from '@/lib/db/credits'
import { PricingClient } from './PricingClient'
import { getIpCountry, resolveBillingMarket } from '@/lib/billing/market'
import { formatPrice, priceFor, type ProductKey } from '@/lib/billing/pricing'
import { SiteHeader, SiteFooter } from '@/components/SiteHeader'

export const metadata: Metadata = {
  title: 'Plans — Urushi Labs',
  robots: { index: false },
}

interface PageProps {
  searchParams: Promise<{ followup?: string }>
}

export default async function PricingPage({ searchParams }: PageProps) {
  const user = await getUser()
  if (!user) redirect('/auth?next=/pricing')

  const [credits, { followup }, headerStore] = await Promise.all([
    getOrCreateCredits(user.id),
    searchParams,
    headers(),
  ])

  // Resolved on the server because cf-ipcountry only exists on the request.
  // A guess, and labelled as one in the UI — the buyer can change it, and what
  // they are actually charged is shown by the gateway before they confirm.
  const { market, country } = resolveBillingMarket({ ipCountry: getIpCountry(headerStore) })

  const productKeys: ProductKey[] = ['1_room', '3_rooms', '10_followups']
  const prices = Object.fromEntries(
    productKeys.map((key) => [key, formatPrice(priceFor(market, key))])
  ) as Record<ProductKey, string>

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <SiteHeader userEmail={user.email} />
      <main className="flex-grow">
        <PricingClient
          roomsAvailable={credits.rooms_available}
          followUpsAvailable={credits.follow_ups_available}
          totalRoomsCreated={credits.total_rooms_created}
          isFollowUp={followup === '1'}
          prices={prices}
          market={market}
          country={country}
        />
      </main>
      <SiteFooter />
    </div>
  )
}
