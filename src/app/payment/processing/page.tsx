'use client'

import { useEffect, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'

/** How long to wait for the webhook before saying so. */
const POLL_INTERVAL_MS = 1500
const GIVE_UP_AFTER_MS = 40_000

function ProcessingContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const paymentId = searchParams.get('paymentId')
  const product = searchParams.get('product')
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    if (!paymentId) {
      router.replace('/pricing')
      return
    }

    let cancelled = false
    const startedAt = Date.now()

    /**
     * Polls for what the webhook has recorded.
     *
     * This page used to POST to /api/payments/verify and settle the payment
     * itself, which put crediting on the one path that is not guaranteed to
     * run. Stripe settles through the webhook and retries it until it gets a
     * 2xx; the browser arriving here is incidental and sometimes never happens.
     */
    async function poll() {
      if (cancelled) return

      try {
        const res = await fetch(`/api/payments/${paymentId}/status`)
        if (res.ok) {
          const { status } = await res.json() as { status: string }
          if (status === 'completed') {
            router.replace(`/payment/success?product=${product ?? ''}`)
            return
          }
          if (status === 'failed') {
            router.replace(`/payment/failed?paymentId=${paymentId}`)
            return
          }
        }
      } catch {
        // A dropped request here means nothing — the webhook is unaffected by
        // whether this page can reach the server. Keep polling.
      }

      if (Date.now() - startedAt > GIVE_UP_AFTER_MS) {
        // Deliberately NOT the failure page. The payment very likely succeeded
        // and the webhook is late or retrying; telling someone who has just
        // paid that it failed is the worst thing this screen can do.
        setSlow(true)
        return
      }

      setTimeout(poll, POLL_INTERVAL_MS)
    }

    void poll()
    return () => { cancelled = true }
  }, [paymentId, product, router])

  if (slow) {
    return (
      <div className="flex flex-col min-h-screen bg-surface items-center justify-center px-margin-mobile text-center">
        <div className="mb-12 max-w-xs">
          <span className="material-symbols-outlined text-primary text-[40px] mb-4">schedule</span>
          <h1 className="font-headline-lg text-on-surface mb-3">This is taking longer than usual</h1>
          <p className="text-on-surface-variant font-body-md mb-6">
            Your payment has gone through. We are waiting on confirmation from our payment provider,
            and your credits will appear automatically once it arrives — usually within a few minutes.
            You do not need to pay again.
          </p>
          <Link
            href="/dashboard"
            className="inline-block bg-primary text-on-primary rounded-full px-6 py-3 font-medium"
          >
            Go to dashboard
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-screen bg-surface items-center justify-center px-margin-mobile text-center">
      <div className="mb-12">
        <div className="w-16 h-16 rounded-full border-4 border-primary border-t-transparent animate-spin mx-auto mb-8" />
        <h1 className="font-headline-lg text-on-surface mb-3">Confirming your payment</h1>
        <p className="text-on-surface-variant font-body-md max-w-xs mx-auto">
          This usually takes a few seconds. Your credits are added automatically once confirmed.
        </p>
        <div className="flex items-center justify-center gap-1.5 mt-6 text-on-surface-variant text-label-sm">
          <span className="material-symbols-outlined text-[14px]">shield</span>
          Secure Transaction
        </div>
      </div>
    </div>
  )
}

export default function PaymentProcessingPage() {
  return (
    <Suspense>
      <ProcessingContent />
    </Suspense>
  )
}
