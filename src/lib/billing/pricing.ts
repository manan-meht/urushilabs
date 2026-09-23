/**
 * Server-authoritative pricing for credit packs.
 *
 * Ported from nutriai-fresh's src/lib/billing/pricing.ts, which is the same
 * company's existing billing architecture and already solves the problem this
 * needs solved: one product sold in several currencies through two gateways.
 * Adapted for one-off packs rather than subscriptions.
 *
 * Two rules carried over verbatim, because both exist for good reasons:
 *
 * Prices are integer MINOR units — cents, paise — never floats. Money in
 * floating point accumulates error and every gateway API takes minor units
 * anyway.
 *
 * The browser never supplies a price, currency or product. It names a product
 * key and a market; the server looks up what that costs. A checkout that trusts
 * a client-supplied amount is a checkout that can be charged a rupee.
 */

export type BillingMarket = 'IN' | 'SG' | 'US' | 'INTL'

/** The credit packs, matching the existing PRODUCTS keys in db/credits.ts. */
export type ProductKey = '1_room' | '3_rooms' | '10_followups'

export interface PricePoint {
  /** Integer minor units — 299 = $2.99, 19900 = ₹199.00. */
  amountMinorUnits: number
  /** ISO 4217. */
  currency: string
}

/**
 * What each pack costs in each market.
 *
 * INTL always bills USD and is never converted at a live rate: a price that
 * moves with the exchange rate is a price you cannot put on a page, reconcile,
 * or refund cleanly.
 *
 * The USD/SGD figures are NOT a direct conversion of the rupee price (₹199 is
 * about $2.39). They are rounded to points that read as prices, which is both
 * conventional and necessary — Stripe's minimum charge is around $0.50 and
 * per-transaction fees eat a much larger share of a $2.39 sale than of a ₹199
 * one.
 */
export const PRICING: Record<BillingMarket, Record<ProductKey, PricePoint>> = {
  IN: {
    '1_room': { amountMinorUnits: 19900, currency: 'INR' },
    '3_rooms': { amountMinorUnits: 49900, currency: 'INR' },
    '10_followups': { amountMinorUnits: 19900, currency: 'INR' },
  },
  SG: {
    '1_room': { amountMinorUnits: 400, currency: 'SGD' },
    '3_rooms': { amountMinorUnits: 900, currency: 'SGD' },
    '10_followups': { amountMinorUnits: 400, currency: 'SGD' },
  },
  US: {
    '1_room': { amountMinorUnits: 300, currency: 'USD' },
    '3_rooms': { amountMinorUnits: 700, currency: 'USD' },
    '10_followups': { amountMinorUnits: 300, currency: 'USD' },
  },
  INTL: {
    '1_room': { amountMinorUnits: 300, currency: 'USD' },
    '3_rooms': { amountMinorUnits: 700, currency: 'USD' },
    '10_followups': { amountMinorUnits: 300, currency: 'USD' },
  },
}

/**
 * The price to charge, looked up server-side.
 *
 * The only sanctioned way to get an amount. Nothing should read PRICING
 * directly at a checkout boundary, and nothing should ever accept an amount
 * from a request body.
 */
export function priceFor(market: BillingMarket, product: ProductKey): PricePoint {
  return PRICING[market][product]
}

/** Formatted for display. Minor units back to major, with the right symbol. */
export function formatPrice(price: PricePoint): string {
  const major = price.amountMinorUnits / 100
  const symbols: Record<string, string> = { INR: '₹', USD: 'US$', SGD: 'S$' }
  const symbol = symbols[price.currency] ?? `${price.currency} `
  // Whole amounts read better without trailing zeros: $3, not $3.00.
  const shown = Number.isInteger(major) ? String(major) : major.toFixed(2)
  return `${symbol}${shown}`
}
