import { describe, it, expect } from 'vitest'
import { toFormParams, verifyStripeWebhookSignature } from './stripe'

const SECRET = 'whsec_test'

async function sign(rawBody: string, timestamp: number, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`))
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
  return `t=${timestamp},v1=${hex}`
}

const BODY = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' })
const now = () => Math.floor(Date.now() / 1000)

describe('toFormParams', () => {
  it('uses Stripe bracket encoding for nested objects and arrays', () => {
    const p = toFormParams({
      mode: 'payment',
      automatic_tax: { enabled: true },
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: 300 } }],
    })
    expect(p.get('mode')).toBe('payment')
    expect(p.get('automatic_tax[enabled]')).toBe('true')
    expect(p.get('line_items[0][quantity]')).toBe('1')
    expect(p.get('line_items[0][price_data][unit_amount]')).toBe('300')
  })

  it('omits null and undefined rather than sending the strings', () => {
    const p = toFormParams({ a: null, b: undefined, c: 'kept' })
    expect(p.has('a')).toBe(false)
    expect(p.has('b')).toBe(false)
    expect(p.get('c')).toBe('kept')
  })
})

describe('verifyStripeWebhookSignature', () => {
  it('accepts a genuine, current signature', async () => {
    const result = await verifyStripeWebhookSignature(BODY, await sign(BODY, now()), SECRET)
    expect(result).toMatchObject({ valid: true, eventId: 'evt_1', eventType: 'checkout.session.completed' })
  })

  it('refuses when no webhook secret is configured', async () => {
    // Same direction as every other gateway check here: unconfigured refuses
    // rather than falling through to granting something.
    expect(await verifyStripeWebhookSignature(BODY, await sign(BODY, now()), ''))
      .toEqual({ valid: false, reason: 'not_configured' })
  })

  it('refuses a body that was altered after signing', async () => {
    const header = await sign(BODY, now())
    const tampered = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', extra: 'x' })
    expect(await verifyStripeWebhookSignature(tampered, header, SECRET))
      .toEqual({ valid: false, reason: 'mismatch' })
  })

  it('refuses a signature made with a different secret', async () => {
    expect(await verifyStripeWebhookSignature(BODY, await sign(BODY, now(), 'whsec_other'), SECRET))
      .toEqual({ valid: false, reason: 'mismatch' })
  })

  it('refuses a replayed request outside the tolerance window', async () => {
    // The timestamp is what stops a captured request being replayed later; the
    // signature over it stays valid forever otherwise.
    const old = now() - 600
    expect(await verifyStripeWebhookSignature(BODY, await sign(BODY, old), SECRET))
      .toEqual({ valid: false, reason: 'stale' })
  })

  it('refuses malformed or missing headers', async () => {
    expect(await verifyStripeWebhookSignature(BODY, null, SECRET)).toEqual({ valid: false, reason: 'malformed' })
    expect(await verifyStripeWebhookSignature(BODY, 'garbage', SECRET)).toEqual({ valid: false, reason: 'malformed' })
    expect(await verifyStripeWebhookSignature(BODY, `t=${now()}`, SECRET)).toEqual({ valid: false, reason: 'malformed' })
  })

  it('refuses a correctly signed body that is not a Stripe event', async () => {
    const body = JSON.stringify({ hello: 'world' })
    expect(await verifyStripeWebhookSignature(body, await sign(body, now()), SECRET))
      .toEqual({ valid: false, reason: 'malformed' })
  })
})
