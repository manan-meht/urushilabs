import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { PRODUCTS, type ProductKey } from '@/lib/db/credits'
import { retrieveCheckoutSession, verifyStripeWebhookSignature } from '@/lib/billing/providers/stripe'
import { handleChargeDisputeCreated, handleChargeRefunded } from '@/lib/billing/refunds'

/**
 * Stripe's callback, and the only thing that grants or reverses credits.
 *
 * The browser returning from checkout does NOT credit anything. That redirect
 * is lost whenever someone closes the tab, loses signal, or is bounced through
 * a bank's 3DS page that never comes back — and every one of those is a real
 * customer who paid and received nothing. The webhook is the only path Stripe
 * guarantees, retrying until it gets a 2xx.
 */
export async function POST(req: NextRequest) {
  // The RAW body. Parsing and re-serialising changes the bytes and every
  // signature then fails, so nothing may call req.json() before this.
  const rawBody = await req.text()
  const signature = req.headers.get('stripe-signature')

  const verified = await verifyStripeWebhookSignature(rawBody, signature)
  if (!verified.valid) {
    if (verified.reason === 'not_configured') {
      console.error('[stripe webhook] STRIPE_WEBHOOK_SECRET is not set — refusing.')
      return new NextResponse('Not configured', { status: 503 })
    }
    console.warn(`[stripe webhook] Rejected: ${verified.reason}`)
    return new NextResponse('Invalid signature', { status: 400 })
  }

  // Everything below returns 200, including events we ignore or have already
  // handled. A non-2xx tells Stripe to retry, and retrying something we
  // deliberately skipped just repeats forever.
  if (
    verified.eventType !== 'checkout.session.completed' &&
    verified.eventType !== 'charge.refunded' &&
    verified.eventType !== 'charge.dispute.created'
  ) {
    return NextResponse.json({ received: true, result: 'ignored' })
  }

  try {
    // Money going back out, handled under the same rule as money coming in: the
    // only retryable failure is the one where the credit ledger disagrees with
    // what the customer's card now says.
    if (verified.eventType === 'charge.refunded' || verified.eventType === 'charge.dispute.created') {
      const handled =
        verified.eventType === 'charge.refunded'
          ? await handleChargeRefunded(verified.payload)
          : await handleChargeDisputeCreated(verified.payload)

      if (handled.retry) {
        console.error(`[stripe webhook] ${verified.eventType} failed: ${handled.message}`)
        return new NextResponse('Reversal failed', { status: 500 })
      }

      return NextResponse.json({ received: true, result: handled.result })
    }

    const event = verified.payload as { data?: { object?: { id?: string } } }
    const sessionId = event.data?.object?.id
    if (!sessionId) return NextResponse.json({ received: true, result: 'ignored' })

    // Re-read from Stripe rather than trusting the payload. The signature proves
    // the body came from Stripe; re-reading proves the session is still in the
    // state the body claimed.
    const session = await retrieveCheckoutSession(sessionId)
    if (session.payment_status !== 'paid') {
      return NextResponse.json({ received: true, result: 'not_paid' })
    }

    const paymentId = session.metadata?.['payment_id']
    if (!paymentId) {
      console.error(`[stripe webhook] Session ${sessionId} has no payment_id metadata.`)
      return NextResponse.json({ received: true, result: 'no_payment_id' })
    }

    const db = getServiceClient()
    const { data: payment } = await db
      .from('payments')
      .select('id, user_id, product_key, status')
      .eq('id', paymentId)
      .maybeSingle()

    if (!payment) {
      console.error(`[stripe webhook] payment ${paymentId} not found.`)
      return NextResponse.json({ received: true, result: 'unknown_payment' })
    }

    // The buyer deleted their account between paying and this event arriving.
    //
    // payments.user_id became nullable in migration 020, which anonymises
    // financial records rather than deleting them — tax retention outlives a
    // deletion request, but the identity does not. Passing the NULL through
    // would fail add_user_credits on user_credits' primary key and, because
    // failed crediting answers 500 to get a retry, Stripe would redeliver this
    // forever against an account that no longer exists.
    //
    // 200, so the retries stop. Logged as an error because money was taken and
    // nothing can be granted for it — that is a refund a human has to make.
    if (!payment.user_id) {
      console.error(
        `[stripe webhook] payment ${paymentId} has no user (account deleted). ` +
        'Money was taken and no credits can be granted — needs a manual refund.'
      )
      return NextResponse.json({ received: true, result: 'user_deleted' })
    }

    const product = PRODUCTS[payment.product_key as ProductKey]
    if (!product) {
      console.error(`[stripe webhook] payment ${paymentId} has unknown product ${payment.product_key}.`)
      return NextResponse.json({ received: true, result: 'unknown_product' })
    }

    await db.from('payments').update({
      provider: 'stripe',
      provider_order_id: sessionId,
      provider_payment_id: sessionId,
    }).eq('id', paymentId)

    // Settlement and crediting happen together inside the function, under the
    // payment's row lock — so this racing the return page credits exactly once
    // whichever arrives first. `false` means it was already done.
    const { data: credited, error } = await db.rpc('add_user_credits', {
      p_user_id: payment.user_id,
      p_rooms: product.rooms,
      p_follow_ups: product.followUps,
      p_payment_id: paymentId,
    })

    if (error) {
      // The one case worth a retry: the money is taken and the credits are not
      // granted, so a 500 asks Stripe to deliver again.
      console.error(`[stripe webhook] Crediting failed for payment ${paymentId}:`, error.message)
      return new NextResponse('Crediting failed', { status: 500 })
    }

    return NextResponse.json({
      received: true,
      result: credited === false ? 'already_credited' : 'credited',
    })
  } catch (err) {
    console.error('[stripe webhook] Processing error:', err instanceof Error ? err.message : err)
    return new NextResponse('Processing error', { status: 500 })
  }
}
