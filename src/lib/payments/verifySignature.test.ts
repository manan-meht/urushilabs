import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { verifyRazorpaySignature } from './verifySignature'

const SECRET = 'test_secret_key'
const ORDER = 'order_ABC123'
const PAYMENT = 'pay_XYZ789'

function sign(orderId: string, paymentId: string, secret = SECRET): string {
  return crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex')
}

describe('verifyRazorpaySignature', () => {
  it('accepts a genuine signature', () => {
    expect(verifyRazorpaySignature({
      orderId: ORDER, paymentId: PAYMENT, signature: sign(ORDER, PAYMENT), secret: SECRET,
    })).toEqual({ ok: true })
  })

  it('refuses when the secret is not configured', () => {
    // The direction that matters. The original bug was a missing check that fell
    // THROUGH to crediting the account; an unconfigured deployment must refuse,
    // not skip verification.
    expect(verifyRazorpaySignature({
      orderId: ORDER, paymentId: PAYMENT, signature: sign(ORDER, PAYMENT), secret: undefined,
    })).toEqual({ ok: false, reason: 'not_configured' })
  })

  it('refuses a forged signature', () => {
    expect(verifyRazorpaySignature({
      orderId: ORDER, paymentId: PAYMENT, signature: 'a'.repeat(64), secret: SECRET,
    })).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('refuses a signature made with a different secret', () => {
    expect(verifyRazorpaySignature({
      orderId: ORDER, paymentId: PAYMENT, signature: sign(ORDER, PAYMENT, 'wrong_secret'), secret: SECRET,
    })).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('refuses a signature lifted from a DIFFERENT order', () => {
    // Replay across orders: without binding to the order id, one real payment
    // could be presented repeatedly against new pending orders.
    expect(verifyRazorpaySignature({
      orderId: 'order_OTHER', paymentId: PAYMENT, signature: sign(ORDER, PAYMENT), secret: SECRET,
    })).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('refuses when the callback fields are absent', () => {
    // How the exploit was actually reachable: POST only a paymentId, omit the
    // Razorpay fields entirely, and the old code credited the account.
    expect(verifyRazorpaySignature({ orderId: ORDER, secret: SECRET }))
      .toEqual({ ok: false, reason: 'missing_fields' })
    expect(verifyRazorpaySignature({ orderId: null, paymentId: PAYMENT, signature: 'x', secret: SECRET }))
      .toEqual({ ok: false, reason: 'missing_fields' })
  })

  it('does not throw on a malformed signature of the wrong length', () => {
    expect(() => verifyRazorpaySignature({
      orderId: ORDER, paymentId: PAYMENT, signature: 'short', secret: SECRET,
    })).not.toThrow()
    expect(verifyRazorpaySignature({
      orderId: ORDER, paymentId: PAYMENT, signature: 'short', secret: SECRET,
    })).toEqual({ ok: false, reason: 'mismatch' })
  })
})
