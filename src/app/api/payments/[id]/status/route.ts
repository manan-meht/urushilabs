import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/db/client'

/**
 * Has this payment settled yet?
 *
 * The return page polls this rather than settling anything itself. Crediting
 * belongs to the Stripe webhook, which is the only delivery Stripe guarantees —
 * the browser redirect is lost whenever someone closes the tab or a bank's 3DS
 * page fails to bounce them back.
 *
 * That makes this a read. It reports what the webhook has recorded and never
 * writes, so a buyer refreshing the page cannot credit themselves.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  const db = getServiceClient()
  const { data: payment } = await db
    .from('payments')
    .select('id, status, product_key')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!payment) return NextResponse.json({ error: 'Payment not found.' }, { status: 404 })

  return NextResponse.json({
    status: payment.status as 'pending' | 'completed' | 'failed',
    productKey: payment.product_key,
  })
}
