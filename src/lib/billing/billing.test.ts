import { describe, it, expect } from 'vitest'
import { marketForCountry, getIpCountry, resolveBillingMarket, requestOrigin } from './market'
import { priceFor, formatPrice, PRICING } from './pricing'
import { providerNameForMarket, isProviderEnabled } from './providerRegistry'

describe('marketForCountry', () => {
  it('maps the launch countries', () => {
    expect(marketForCountry('IN')).toBe('IN')
    expect(marketForCountry('sg')).toBe('SG')
    expect(marketForCountry('US')).toBe('US')
  })

  it('sends everywhere else to INTL', () => {
    for (const c of ['GB', 'AE', 'DE', 'ZZ']) expect(marketForCountry(c), c).toBe('INTL')
  })

  it('falls back to INTL when the country is unknown', () => {
    expect(marketForCountry(null)).toBe('INTL')
    expect(marketForCountry(undefined)).toBe('INTL')
  })
})

describe('getIpCountry', () => {
  it('reads the Cloudflare header', () => {
    expect(getIpCountry(new Headers({ 'cf-ipcountry': 'sg' }))).toBe('SG')
  })

  it("treats Cloudflare's unknown placeholders as unknown", () => {
    // XX and T1 mean "could not determine" and "Tor". Mapping either to a real
    // market would price someone by accident.
    expect(getIpCountry(new Headers({ 'cf-ipcountry': 'XX' }))).toBeNull()
    expect(getIpCountry(new Headers({ 'cf-ipcountry': 'T1' }))).toBeNull()
    expect(getIpCountry(new Headers())).toBeNull()
  })
})

describe('resolveBillingMarket', () => {
  it('lets an explicit choice beat the IP guess', () => {
    // The rule that makes IP inference safe to use at all: an Indian card
    // holder travelling through Singapore is not billed in SGD because of it.
    const r = resolveBillingMarket({ confirmedCountry: 'IN', ipCountry: 'SG' })
    expect(r).toEqual({ market: 'IN', country: 'IN', confirmed: true })
  })

  it('uses the IP when nothing was chosen, and says it was not confirmed', () => {
    expect(resolveBillingMarket({ ipCountry: 'US' }))
      .toEqual({ market: 'US', country: 'US', confirmed: false })
  })

  it('falls back to INTL with nothing at all', () => {
    expect(resolveBillingMarket({})).toEqual({ market: 'INTL', country: null, confirmed: false })
  })
})

describe('requestOrigin', () => {
  it('is https behind Cloudflare', () => {
    expect(requestOrigin(new Headers({ host: 'urushilabs.com', 'x-forwarded-proto': 'https' })))
      .toBe('https://urushilabs.com')
  })

  it('is http on localhost, so gateway redirects can be answered', () => {
    // Hardcoding https sends the success redirect to an https://localhost the
    // dev server cannot serve.
    expect(requestOrigin(new Headers({ host: 'localhost:3000' }))).toBe('http://localhost:3000')
  })
})

describe('pricing', () => {
  it('prices every product in every market', () => {
    for (const market of Object.keys(PRICING) as Array<keyof typeof PRICING>) {
      for (const product of ['1_room', '3_rooms', '10_followups'] as const) {
        const p = priceFor(market, product)
        expect(p.amountMinorUnits, `${market}/${product}`).toBeGreaterThan(0)
        expect(Number.isInteger(p.amountMinorUnits), `${market}/${product} must be minor units`).toBe(true)
      }
    }
  })

  it('keeps the existing rupee prices unchanged', () => {
    expect(priceFor('IN', '1_room')).toEqual({ amountMinorUnits: 19900, currency: 'INR' })
    expect(priceFor('IN', '3_rooms')).toEqual({ amountMinorUnits: 49900, currency: 'INR' })
  })

  it('bills INTL in USD', () => {
    expect(priceFor('INTL', '1_room').currency).toBe('USD')
  })

  it('discounts the 3-pack against three singles in every market', () => {
    for (const market of Object.keys(PRICING) as Array<keyof typeof PRICING>) {
      const single = priceFor(market, '1_room').amountMinorUnits
      const pack = priceFor(market, '3_rooms').amountMinorUnits
      expect(pack, market).toBeLessThan(single * 3)
    }
  })

  it('clears the Stripe minimum charge in every non-INR market', () => {
    // Stripe rejects charges under roughly $0.50; a price below it is a product
    // that cannot be sold.
    for (const market of ['US', 'SG', 'INTL'] as const) {
      expect(priceFor(market, '1_room').amountMinorUnits, market).toBeGreaterThanOrEqual(50)
    }
  })

  it('formats without trailing zeros on whole amounts', () => {
    expect(formatPrice({ amountMinorUnits: 300, currency: 'USD' })).toBe('US$3')
    expect(formatPrice({ amountMinorUnits: 19900, currency: 'INR' })).toBe('₹199')
    expect(formatPrice({ amountMinorUnits: 299, currency: 'USD' })).toBe('US$2.99')
  })
})

describe('providerNameForMarket', () => {
  it('routes India to Razorpay and everywhere else to Stripe', () => {
    expect(providerNameForMarket('IN')).toBe('razorpay')
    for (const m of ['SG', 'US', 'INTL'] as const) expect(providerNameForMarket(m)).toBe('stripe')
  })

  it('reports a gateway as disabled until its secret is configured', () => {
    // Razorpay activation is pending, so its path must stay shut rather than
    // half-working.
    expect(isProviderEnabled('razorpay', {})).toBe(false)
    expect(isProviderEnabled('stripe', {})).toBe(false)
    expect(isProviderEnabled('stripe', { STRIPE_SECRET_KEY: 'sk_test_x' })).toBe(true)
  })
})
