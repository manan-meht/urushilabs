/**
 * Stripe, over plain fetch against the REST API.
 *
 * Deliberately NOT the `stripe` npm SDK, following nutriai-fresh's provider of
 * the same name and for the reason recorded there: the SDK registers every API
 * resource class up front, barely tree-shakes, and was on its own responsible
 * for a large share of every billing-touching route's Cloudflare bundle. Stripe's
 * API is plain REST with form encoding, and this file needs three endpoints.
 *
 * urushi ships to Cloudflare Workers through the same OpenNext adapter and has
 * the same 25 MiB ceiling, so the same reasoning applies before anyone reaches
 * for the SDK.
 */

import { getEnv } from '@/lib/env'
import type { PricePoint } from '../pricing'

const STRIPE_API = 'https://api.stripe.com/v1'

function apiKey(): string {
  const { STRIPE_SECRET_KEY } = getEnv()
  if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured.')
  return STRIPE_SECRET_KEY
}

/**
 * Flattens nested params into Stripe's bracketed form encoding —
 * `{ line_items: [{ price_data: { currency: 'usd' } }] }` becomes
 * `line_items[0][price_data][currency]=usd`, which is what Stripe's own
 * clients produce.
 */
export function toFormParams(input: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams()
  function walk(value: unknown, key: string): void {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${key}[${i}]`))
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, `${key}[${k}]`)
    } else {
      params.append(key, String(value))
    }
  }
  for (const [k, v] of Object.entries(input)) walk(v, k)
  return params
}

async function stripeRequest<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
  const url = method === 'GET' && body ? `${STRIPE_API}${path}?${toFormParams(body)}` : `${STRIPE_API}${path}`
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(method === 'POST' && body ? { body: toFormParams(body).toString() } : {}),
  })
  if (!res.ok) {
    throw new Error(`Stripe ${method} ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }
  return res.json() as Promise<T>
}

export interface CheckoutSessionParams {
  /** Our own payments row id. The webhook uses this to find what to credit. */
  paymentId: string
  productLabel: string
  price: PricePoint
  successUrl: string
  cancelUrl: string
  customerEmail?: string | null
}

export interface CheckoutSession {
  id: string
  url: string
}

/**
 * A hosted Checkout session for a one-off pack.
 *
 * Hosted rather than embedded card fields: card data never reaches our origin,
 * and 3DS/SCA is Stripe's problem rather than ours.
 *
 * `automatic_tax` is on because Tistra is GST-registered in Singapore. Stripe
 * then works out whether GST applies from the buyer's location, which is why
 * billing address collection is required — without an address it has nothing to
 * decide on, and a missing address is the usual reason tax silently comes back
 * as zero.
 *
 * `tax_behavior: 'inclusive'` means the listed price is what the buyer pays,
 * with any GST carved out of it rather than added on top. That matches how
 * consumer prices are shown in Singapore, and means a price on the pricing page
 * is never contradicted at checkout.
 */
export async function createCheckoutSession(params: CheckoutSessionParams): Promise<CheckoutSession> {
  return stripeRequest<CheckoutSession>('POST', '/checkout/sessions', {
    mode: 'payment',
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    billing_address_collection: 'required',
    automatic_tax: { enabled: true },
    ...(params.customerEmail ? { customer_email: params.customerEmail } : {}),
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: params.price.currency.toLowerCase(),
          unit_amount: params.price.amountMinorUnits,
          tax_behavior: 'inclusive',
          product_data: { name: params.productLabel },
        },
      },
    ],
    // Echoed back on the webhook event. The payment row is the only thing the
    // webhook trusts from us; everything else it re-reads from Stripe.
    metadata: { payment_id: params.paymentId },
    payment_intent_data: { metadata: { payment_id: params.paymentId } },
  })
}

/** Re-read a session, rather than trusting what a webhook body claims it was. */
export async function retrieveCheckoutSession(sessionId: string): Promise<{
  id: string
  payment_status: string
  metadata?: Record<string, string>
  amount_total?: number
  currency?: string
}> {
  return stripeRequest('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`)
}

export type WebhookVerifyResult =
  | { valid: true; eventId: string; eventType: string; payload: Record<string, unknown> }
  | { valid: false; reason: 'not_configured' | 'malformed' | 'stale' | 'mismatch' }

/**
 * Verifies a Stripe webhook signature using Web Crypto, which is what is
 * available on Workers.
 *
 * Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256 under the endpoint
 * secret. The raw body matters: parsing and re-serialising the JSON changes the
 * bytes and every signature then fails.
 *
 * The timestamp tolerance is what stops a captured request being replayed later.
 */
export async function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret?: string
): Promise<WebhookVerifyResult> {
  const webhookSecret = secret ?? getEnv().STRIPE_WEBHOOK_SECRET
  if (!webhookSecret) return { valid: false, reason: 'not_configured' }
  if (!signatureHeader) return { valid: false, reason: 'malformed' }

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const i = p.indexOf('=')
      return i === -1 ? [p, ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()]
    })
  ) as Record<string, string>

  const timestamp = parts['t']
  const signature = parts['v1']
  if (!timestamp || !signature) return { valid: false, reason: 'malformed' }

  // 5 minutes, matching Stripe's own default tolerance.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (!Number.isFinite(age) || age > 300) return { valid: false, reason: 'stale' }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`))
  const expected = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')

  if (!timingSafeEqualHex(expected, signature)) return { valid: false, reason: 'mismatch' }

  try {
    const event = JSON.parse(rawBody) as { id?: string; type?: string }
    if (!event.id || !event.type) return { valid: false, reason: 'malformed' }
    return { valid: true, eventId: event.id, eventType: event.type, payload: event as Record<string, unknown> }
  } catch {
    return { valid: false, reason: 'malformed' }
  }
}

/** Constant-time comparison of two hex strings, without Node's Buffer. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
