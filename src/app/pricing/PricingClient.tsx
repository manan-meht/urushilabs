'use client'

import { useState } from 'react'
import Link from 'next/link'

type ProductKey = '1_room' | '3_rooms' | '10_followups'

interface Product {
  key: ProductKey
  label: string
  description: string
  badge?: string
  features: string[]
}

const ROOM_PRODUCTS: Product[] = [
  {
    key: '1_room',
    label: '1 Room Pack',
    description: 'Access to 1 mediation room',
    features: ['1 new mediation room', 'Full AI-facilitated session', 'Shared report for both parties'],
  },
  {
    key: '3_rooms',
    label: '3 Room Pack',
    description: 'Access to 3 mediation rooms',
    badge: 'BEST VALUE',
    features: ['3 new mediation rooms', 'Full AI-facilitated sessions', 'Shared reports for all rooms'],
  },
]

const FOLLOWUP_PRODUCT: Product = {
  key: '10_followups',
  label: 'Follow-up Pack',
  description: '10 Additional AI-mediated responses',
  features: [
    '10 Additional AI-mediated responses',
    'Deep conflict analysis report',
    '24-hour priority resolution window',
  ],
}

interface Props {
  roomsAvailable: number
  followUpsAvailable: number
  totalRoomsCreated: number
  isFollowUp: boolean
  /**
   * Formatted prices for this buyer's market, resolved server-side.
   *
   * Passed in rather than held here because the market comes from a request
   * header this component never sees, and because a price a client component
   * decides is a price that can be edited before it is sent. The server charges
   * what IT looks up; these strings are display only.
   */
  prices: Record<ProductKey, string>
  market: string
  country: string | null
}

/** Explains the currency, and names the country it was guessed from. */
function currencyNote(market: string, country: string | null): string {
  if (market === 'IN') return 'Charged in Indian rupees.'
  if (market === 'SG') return 'Charged in Singapore dollars.'
  if (market === 'US') return 'Charged in US dollars.'
  return country
    ? `Charged in US dollars, our default outside India and Singapore.`
    : 'Charged in US dollars.'
}

export function PricingClient({ roomsAvailable, followUpsAvailable, totalRoomsCreated, isFollowUp, prices, market, country }: Props) {
  const defaultSelected: ProductKey = isFollowUp ? '10_followups' : '1_room'
  const [selected, setSelected] = useState<ProductKey>(defaultSelected)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const allProducts = isFollowUp ? [FOLLOWUP_PRODUCT, ...ROOM_PRODUCTS] : ROOM_PRODUCTS
  const selectedProduct = allProducts.find((p) => p.key === selected) ?? allProducts[0]!

  async function handlePurchase() {
    setLoading(true)
    setError('')
    try {
      const orderRes = await fetch('/api/payments/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productKey: selected }),
      })
      const order = await orderRes.json() as { paymentId?: string; checkoutUrl?: string; error?: string }
      if (!orderRes.ok || !order.checkoutUrl) {
        setError(order.error ?? 'Failed to start checkout.')
        setLoading(false)
        return
      }
      // A full navigation, not router.push: the gateway's checkout is hosted on
      // its own origin, so this leaves the app entirely. Card details never
      // reach us, and 3DS is handled there.
      window.location.href = order.checkoutUrl
    } catch {
      setError('A network error occurred. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="max-w-md mx-auto px-margin-mobile py-stack-md pb-32">
      {/* Header */}
      <div className="mb-6">
        <Link href="/dashboard" className="flex items-center gap-1 text-on-surface-variant text-label-sm mb-4">
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          Back
        </Link>
        {isFollowUp ? (
          <>
            <p className="text-on-surface-variant font-body-md mb-1">Continue finding common ground</p>
            <p className="text-on-surface-variant text-label-md">
              Your dialogue is showing progress. Adding more responses allows the mediator to deepen the resolution process.
            </p>
          </>
        ) : (
          <>
            <h1 className="font-headline-md text-on-surface mb-1">Choose a plan</h1>
            <p className="text-on-surface-variant text-label-md">
              Start a new mediation room. One payment covers both participants.
            </p>
          </>
        )}
      </div>

      {/* Credit status */}
      {(roomsAvailable > 0 || followUpsAvailable > 0) && (
        <div className="bg-primary-container/20 border border-primary/20 rounded-xl p-4 mb-6 flex items-center gap-3">
          <span className="material-symbols-outlined text-primary text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>account_balance_wallet</span>
          <div className="text-label-md text-on-surface">
            {roomsAvailable > 0 && <span className="block">{roomsAvailable} room{roomsAvailable !== 1 ? 's' : ''} available</span>}
            {followUpsAvailable > 0 && <span className="block">{followUpsAvailable} follow-ups remaining</span>}
          </div>
        </div>
      )}

      {/* Follow-up Pack — only shown in follow-up context, displayed as recommended */}
      {isFollowUp && (
        <button
          onClick={() => setSelected('10_followups')}
          className={`w-full text-left rounded-2xl border-2 p-5 mb-3 transition-all ${
            selected === '10_followups'
              ? 'border-primary bg-primary-container/20'
              : 'border-outline-variant bg-surface-container-low'
          }`}
        >
          <div className="flex justify-between items-start mb-3">
            <div>
              <span className="text-label-sm text-primary uppercase tracking-wider block mb-1">Recommended for you</span>
              <h2 className="font-headline-md text-on-surface text-[20px]">Follow-up Pack</h2>
            </div>
            <div className="text-right">
              <span className="font-headline-md text-on-surface text-[22px] font-bold">{prices['1_room']}</span>
              <span className="block text-label-sm text-on-surface-variant">Inclusive of GST</span>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {FOLLOWUP_PRODUCT.features.map((f) => (
              <div key={f} className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                <span className="text-label-md text-on-surface">{f}</span>
              </div>
            ))}
          </div>
        </button>
      )}

      {/* Room packs */}
      {isFollowUp && (
        <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-3">Need another room instead?</p>
      )}
      <div className="flex flex-col gap-3 mb-6">
        {ROOM_PRODUCTS.map((product) => (
          <button
            key={product.key}
            onClick={() => setSelected(product.key)}
            className={`w-full text-left rounded-2xl border-2 p-4 transition-all relative ${
              selected === product.key
                ? 'border-primary bg-primary-container/20'
                : 'border-outline-variant bg-surface-container-low'
            }`}
          >
            {product.badge && (
              <span className="absolute -top-2.5 right-4 bg-secondary text-on-secondary text-[10px] font-bold px-2 py-0.5 rounded-full tracking-wider">
                {product.badge}
              </span>
            )}
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-on-surface-variant text-[20px]">meeting_room</span>
                <div>
                  <p className="font-medium text-on-surface text-label-md">{product.label}</p>
                  <p className="text-label-sm text-on-surface-variant">{product.description}</p>
                </div>
              </div>
              <span className="font-bold text-on-surface">{prices[product.key]}</span>
            </div>
          </button>
        ))}
      </div>

      {/* Order Summary */}
      <div className="bg-surface-container-low rounded-2xl border border-outline-variant p-4 mb-6">
        <h3 className="font-medium text-on-surface mb-3">Order Summary</h3>
        <div className="flex justify-between text-label-md text-on-surface mb-2">
          <span>{selectedProduct.label}</span>
          <span>{prices[selectedProduct.key]}</span>
        </div>
        <div className="flex justify-between text-label-md text-on-surface-variant mb-3">
          <span>Convenience Fee</span>
          <span className="text-primary font-medium">FREE</span>
        </div>
        <div className="border-t border-outline-variant pt-3 flex justify-between font-bold text-on-surface">
          <span>Total</span>
          <span className="text-[18px]">{prices[selectedProduct.key]}</span>
        </div>
        {/*
          Says which currency this is and why, because the currency was picked
          from the buyer's IP and that is wrong often enough to matter — a
          traveller, a VPN, a mobile carrier routing through another country.
          The charge itself is confirmed by the gateway before anything is taken,
          so this only needs to explain, not to gate.
        */}
        <p className="text-label-sm text-on-surface-variant mt-2">
          {currencyNote(market, country)} Tax, where it applies, is included.
        </p>
        <p className="text-label-sm text-on-surface-variant mt-2 flex items-center gap-1">
          <span className="material-symbols-outlined text-[14px]">info</span>
          One payment covers both participants in this room.
        </p>
      </div>

      {/* Payment methods */}
      <div className="mb-6">
        <h3 className="font-medium text-on-surface mb-3">Select Payment Method</h3>
        <div className="flex flex-col gap-2">
          {[
            { icon: 'account_balance_wallet', label: 'UPI (GPay, PhonePe, BHIM)' },
            { icon: 'credit_card', label: 'Card (Visa, Mastercard, RuPay)' },
            { icon: 'account_balance', label: 'Netbanking' },
            { icon: 'wallet', label: 'Wallets' },
          ].map((method, i) => (
            <div
              key={method.label}
              className={`flex items-center gap-3 p-3 rounded-xl border ${
                i === 0 ? 'border-primary bg-primary-container/10' : 'border-outline-variant bg-surface'
              }`}
            >
              <span className="material-symbols-outlined text-on-surface-variant text-[20px]">{method.icon}</span>
              <span className="text-label-md text-on-surface flex-1">{method.label}</span>
              {i === 0 ? (
                <span className="w-4 h-4 rounded-full border-2 border-primary flex items-center justify-center">
                  <span className="w-2 h-2 rounded-full bg-primary" />
                </span>
              ) : (
                <span className="material-symbols-outlined text-on-surface-variant text-[18px]">chevron_right</span>
              )}
            </div>
          ))}
        </div>
        <p className="text-label-sm text-on-surface-variant text-center mt-3 flex items-center justify-center gap-1">
          <span className="material-symbols-outlined text-[14px]">lock</span>
          Secure payment powered by Razorpay
        </p>
        <p className="text-label-sm text-on-surface-variant text-center mt-1 max-w-xs mx-auto">
          By completing this purchase, you agree to our Terms of Service. Your personal conflict data is encrypted and never shared with payment processors.
        </p>
      </div>

      {error && <p className="text-error text-label-md mb-4 text-center">{error}</p>}

      {/* Sticky CTA */}
      <div className="fixed bottom-0 left-0 right-0 bg-surface border-t border-outline-variant px-margin-mobile py-4 max-w-md mx-auto">
        <div className="flex items-center justify-between mb-2">
          <span className="text-label-sm text-on-surface-variant">Final Total</span>
          <span className="font-bold text-on-surface text-[18px]">{prices[selectedProduct.key]}</span>
        </div>
        <button
          onClick={() => void handlePurchase()}
          disabled={loading}
          className="w-full py-4 bg-primary text-on-primary rounded-xl font-bold text-body-lg shadow-md transition-all active:scale-[0.98] disabled:opacity-50"
        >
          {loading ? 'Processing…' : 'Pay Now'}
        </button>
        {totalRoomsCreated === 0 && (
          <Link href="/start" className="block text-center text-label-sm text-primary mt-3">
            Use your free room instead →
          </Link>
        )}
      </div>
    </div>
  )
}
