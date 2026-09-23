/**
 * Razorpay payment signature verification.
 *
 * Exists because the check it performs was a commented-out TODO in the verify
 * route while the code beneath it credited the account anyway. Any signed-in
 * user could create a pending order, post its id back, and receive a paid credit
 * pack for free. It was live.
 *
 * Kept as a pure function so the rule can be tested directly. The previous
 * version could not be: it was a comment.
 */

import crypto from 'node:crypto'

export type SignatureResult =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'missing_fields' | 'mismatch' }

export interface SignatureInput {
  /** The Razorpay order id stored when the order was created. */
  orderId?: string | null
  /** razorpay_payment_id from the checkout callback. */
  paymentId?: string | null
  /** razorpay_signature from the checkout callback. */
  signature?: string | null
  /** RAZORPAY_KEY_SECRET. Absent means payments are not configured. */
  secret?: string | null
}

/**
 * Whether this callback genuinely came from Razorpay for this order.
 *
 * Razorpay signs `${order_id}|${payment_id}` with HMAC-SHA256 under the key
 * secret. Anything that does not reproduce that digest did not come from them.
 *
 * Every failure path refuses. In particular a MISSING secret fails rather than
 * skipping the check: an unconfigured deployment must refuse to grant credits,
 * not hand them out, which is precisely the direction the original bug fell in.
 */
export function verifyRazorpaySignature(input: SignatureInput): SignatureResult {
  const { orderId, paymentId, signature, secret } = input

  if (!secret) return { ok: false, reason: 'not_configured' }
  if (!orderId || !paymentId || !signature) return { ok: false, reason: 'missing_fields' }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex')

  // timingSafeEqual throws on a length mismatch, which for a fixed-length hex
  // digest only happens for malformed input — so length is checked first.
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature, 'utf8')
  if (a.length !== b.length) return { ok: false, reason: 'mismatch' }

  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'mismatch' }
}
