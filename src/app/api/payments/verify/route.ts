import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'
import { PRODUCTS, type ProductKey } from '@/lib/db/credits'
import { verifyRazorpaySignature } from '@/lib/payments/verifySignature'
import { getEnv } from '@/lib/env'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const { paymentId, razorpayPaymentId, razorpaySignature } = body as {
    paymentId?: string
    razorpayPaymentId?: string
    razorpaySignature?: string
  }

  if (!paymentId) return NextResponse.json({ error: 'paymentId is required.' }, { status: 422 })

  const db = getServiceClient()

  const { data: payment } = await db
    .from('payments')
    .select('id, user_id, product_key, status, razorpay_order_id')
    .eq('id', paymentId)
    .eq('user_id', user.id)
    .single()

  if (!payment) return NextResponse.json({ error: 'Payment not found.' }, { status: 404 })
  if (payment.status === 'completed') return NextResponse.json({ error: 'Payment already processed.' }, { status: 409 })

  // Proof the money actually moved, before anything is credited.
  //
  // This was a commented-out TODO while the code below it credited the account
  // regardless, so a signed-in user could create a pending order, post its id
  // back here, and receive a paid pack for free. Nothing else gated it.
  const { RAZORPAY_KEY_SECRET } = getEnv()
  const signature = verifyRazorpaySignature({
    orderId: payment.razorpay_order_id,
    paymentId: razorpayPaymentId,
    signature: razorpaySignature,
    secret: RAZORPAY_KEY_SECRET,
  })

  if (!signature.ok) {
    // An unconfigured deployment refuses rather than falling through. A broken
    // purchase flow is recoverable; giving credits away is not.
    if (signature.reason === 'not_configured') {
      console.error('[payments/verify] RAZORPAY_KEY_SECRET is not set — refusing to credit.')
      return NextResponse.json(
        { error: 'Payments are not configured on this deployment.' },
        { status: 503 }
      )
    }

    await db.from('payments').update({ status: 'failed' }).eq('id', paymentId)
    console.warn(`[payments/verify] Rejected payment ${paymentId}: ${signature.reason}`)
    return NextResponse.json({ error: 'Signature verification failed.' }, { status: 400 })
  }

  const productKey = payment.product_key as ProductKey
  const product = PRODUCTS[productKey]

  // Mark payment completed
  await db.from('payments').update({
    status: 'completed',
    razorpay_payment_id: razorpayPaymentId ?? null,
    razorpay_signature: razorpaySignature ?? null,
  }).eq('id', paymentId)

  // Credit the user's account atomically
  const { error: creditError } = await db.rpc('add_user_credits', {
    p_user_id: user.id,
    p_rooms: product.rooms,
    p_follow_ups: product.followUps,
  })

  if (creditError) {
    console.error('[verify] Failed to add credits:', creditError)
    // Payment is marked complete — credits will need manual reconciliation.
    // Do not fail the response; log for ops review.
  }

  return NextResponse.json({ success: true, productKey, credits: { rooms: product.rooms, followUps: product.followUps } })
}
