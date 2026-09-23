/**
 * Which gateway handles which market, and how its code is loaded.
 *
 * Ported from nutriai-fresh's provider-registry.ts, including the thing that
 * file's comments exist to warn about: the imports below MUST stay dynamic.
 *
 * This module is reachable from any page that shows a price. A static import of
 * the Stripe Node SDK pulls it into every one of those routes' Worker bundles
 * whether or not they ever charge anything, and in nutriai that pushed the
 * combined bundle past Cloudflare's 25 MiB limit and failed two deploys.
 * urushi-labs ships to Cloudflare Workers through the same OpenNext adapter and
 * has the same ceiling.
 */

import type { BillingMarket } from './pricing'

export type PaymentProviderName = 'stripe' | 'razorpay'

/**
 * India goes to Razorpay; everywhere else to Stripe.
 *
 * Deliberately a pure function of the market so it can be reasoned about and
 * tested without either SDK present.
 */
export function providerNameForMarket(market: BillingMarket): PaymentProviderName {
  return market === 'IN' ? 'razorpay' : 'stripe'
}

/** Whether a gateway is configured and switched on for this deployment. */
export function isProviderEnabled(
  name: PaymentProviderName,
  env: { STRIPE_SECRET_KEY?: string; RAZORPAY_KEY_SECRET?: string }
): boolean {
  return name === 'stripe' ? Boolean(env.STRIPE_SECRET_KEY) : Boolean(env.RAZORPAY_KEY_SECRET)
}
