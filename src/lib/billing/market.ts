/**
 * Which market a buyer is in, and therefore which currency and gateway.
 *
 * Ported from nutriai-fresh's src/lib/billing/market.ts. The precedence rule
 * and the warning attached to it are carried over deliberately.
 */

import type { BillingMarket } from './pricing'

const LAUNCH_COUNTRY_MARKETS: Record<string, BillingMarket> = {
  IN: 'IN',
  SG: 'SG',
  US: 'US',
}

/**
 * ISO 3166-1 alpha-2 country code to billing market.
 *
 * Anything outside the launch markets resolves to INTL and is billed in USD.
 */
export function marketForCountry(countryCode: string | null | undefined): BillingMarket {
  if (!countryCode) return 'INTL'
  return LAUNCH_COUNTRY_MARKETS[countryCode.toUpperCase()] ?? 'INTL'
}

/**
 * The country Cloudflare's edge derived from the connecting IP.
 *
 * `cf-ipcountry` is set by Cloudflare and overwritten on every request, so a
 * client cannot forge it through an ordinary header. That still does NOT make
 * it a security boundary — it is a display default, nothing more. VPNs,
 * travellers and mobile carriers all produce wrong answers routinely, and what
 * a buyer is actually charged must be confirmable by them before they pay.
 *
 * "XX" and "T1" are Cloudflare's own unknown/Tor placeholders.
 */
export function getIpCountry(headers: Headers): string | null {
  const cfCountry = headers.get('cf-ipcountry')
  if (cfCountry && cfCountry !== 'XX' && cfCountry !== 'T1') return cfCountry.toUpperCase()
  return null
}

export interface ResolvedBilling {
  market: BillingMarket
  /** The country the market came from, or null if nothing was determinable. */
  country: string | null
  /** True when the buyer chose this rather than it being inferred from an IP. */
  confirmed: boolean
}

/**
 * The market to price in.
 *
 * Precedence: what the buyer explicitly chose, then what their IP suggests,
 * then INTL. An explicit choice always wins, which is what makes the IP guess
 * safe to use — being wrong is a correctable inconvenience rather than a
 * charge in the wrong currency.
 */
export function resolveBillingMarket(params: {
  confirmedCountry?: string | null
  ipCountry?: string | null
}): ResolvedBilling {
  const confirmed = Boolean(params.confirmedCountry)
  const country = params.confirmedCountry ?? params.ipCountry ?? null
  return { market: marketForCountry(country), country, confirmed }
}

/**
 * Reconstructs the request origin for building gateway redirect URLs.
 *
 * Always https behind Cloudflare, which sets x-forwarded-proto. A local dev
 * server only serves plain http, and hardcoding https sends the gateway's
 * success redirect to an https://localhost the dev server cannot answer.
 */
export function requestOrigin(headers: Headers): string {
  const host = headers.get('host') ?? 'localhost:3000'
  const forwardedProto = headers.get('x-forwarded-proto')
  const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)
  const protocol = forwardedProto ?? (isLocalHost ? 'http' : 'https')
  return `${protocol}://${host}`
}
