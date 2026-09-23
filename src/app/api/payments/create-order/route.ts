import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { getOrCreateCredits, PRODUCTS, type ProductKey } from '@/lib/db/credits'
import { getEnv } from '@/lib/env'
import { getIpCountry, requestOrigin, resolveBillingMarket } from '@/lib/billing/market'
import { priceFor } from '@/lib/billing/pricing'
import { isProviderEnabled, providerNameForMarket } from '@/lib/billing/providerRegistry'

/**
 * Starts a purchase: works out what this buyer is charged, records a pending
 * payment, and opens a checkout session with whichever gateway serves them.
 *
 * The price is looked up here, server-side, from the product key and the
 * resolved market. The request body names a product; it never supplies an
 * amount or a currency. That is the whole reason this endpoint exists rather
 * than the browser talking to Stripe directly.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const { productKey, country } = body as { productKey?: string; country?: string }
  if (!productKey || !(productKey in PRODUCTS)) {
    return NextResponse.json({ error: 'Invalid product.' }, { status: 422 })
  }

  const product = PRODUCTS[productKey as ProductKey]

  // A country the buyer picked beats the one their IP suggests. Neither decides
  // anything but currency — the charge is shown to them before they confirm.
  const { market } = resolveBillingMarket({
    confirmedCountry: country ?? null,
    ipCountry: getIpCountry(req.headers),
  })
  const price = priceFor(market, productKey as ProductKey)

  const providerName = providerNameForMarket(market)
  const env = getEnv()

  if (!isProviderEnabled(providerName, env)) {
    // Razorpay's India approval is still pending. Saying so plainly beats
    // opening a checkout that cannot complete.
    console.warn(`[create-order] ${providerName} is not configured; refusing checkout for market ${market}.`)
    return NextResponse.json(
      {
        error: providerName === 'razorpay'
          ? 'Card payments in India are not available yet. We are finishing activation with our payment provider.'
          : 'Payments are not configured on this deployment.',
      },
      { status: 503 }
    )
  }

  const db = getServiceClient()
  await getOrCreateCredits(user.id)

  const { data: payment, error } = await db
    .from('payments')
    .insert({
      user_id: user.id,
      product_key: productKey,
      amount_paise: price.amountMinorUnits,
      currency: price.currency,
      market,
      provider: providerName,
      status: 'pending',
    })
    .select('id')
    .single()

  if (error || !payment) {
    console.error('[create-order] DB error:', error)
    return NextResponse.json({ error: 'Failed to create order.' }, { status: 500 })
  }

  // Dynamic import, so the gateway code is not pulled into every route that
  // merely links here — see providerRegistry for why that matters on Workers.
  const { createCheckoutSession } = await import('@/lib/billing/providers/stripe')
  const origin = requestOrigin(req.headers)

  try {
    const session = await createCheckoutSession({
      paymentId: payment.id,
      productLabel: product.label,
      price,
      customerEmail: user.email ?? null,
      successUrl: `${origin}/payment/processing?paymentId=${payment.id}&product=${productKey}`,
      cancelUrl: `${origin}/pricing`,
    })

    await db.from('payments')
      .update({ provider_order_id: session.id })
      .eq('id', payment.id)

    return NextResponse.json({
      paymentId: payment.id,
      productKey,
      checkoutUrl: session.url,
      amountMinorUnits: price.amountMinorUnits,
      currency: price.currency,
      label: product.label,
    })
  } catch (err) {
    // The pending row is left behind on purpose: it is the record that someone
    // tried and could not, which is the first thing worth knowing when checkout
    // starts failing.
    await db.from('payments').update({ status: 'failed' }).eq('id', payment.id)
    console.error('[create-order] Checkout session failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not start checkout. Please try again.' }, { status: 502 })
  }
}
