'use client'

/**
 * The only way a user can delete their account and their data.
 *
 * Collapsed by default and placed last: it is not a routine action, and a
 * permanently visible "delete everything" control on the page people use to open
 * their conversations is a mis-tap waiting to happen.
 *
 * The copy lists what goes AND what stays, from the same constants the deletion
 * itself is documented by, because the two ways this screen could be dishonest
 * are promising deletion of records that Singapore tax law obliges Tistra to
 * keep, and quietly keeping them without saying so.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  DELETED_ON_ACCOUNT_DELETION,
  DELETION_CONFIRMATION_PHRASE,
  RETAINED_ON_ACCOUNT_DELETION,
} from '@/lib/account/deletion'

export function DeleteAccount() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [phrase, setPhrase] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmPhrase: phrase }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setError(data.error ?? 'We could not complete the deletion. Please try again.')
        setSubmitting(false)
        return
      }
      // Their session is gone with the account, so a client-side route change
      // would land on a page that immediately redirects to /auth anyway. A full
      // reload also drops any cached server-rendered dashboard.
      window.location.href = '/'
    } catch {
      setError('We could not reach the server. Nothing has been deleted.')
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <div className="mt-12 pt-6 border-t border-outline-variant">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="font-label-sm text-on-surface-variant hover:text-error hover:underline"
        >
          Delete my account and data
        </button>
      </div>
    )
  }

  return (
    <div className="mt-12 pt-6 border-t border-outline-variant">
      <div className="rounded-xl border border-error/40 bg-error-container/30 p-4">
        <h2 className="font-headline-sm text-on-surface mb-2">Delete your account and data</h2>
        <p className="font-body-md text-on-surface-variant mb-4">
          This cannot be undone. There is no backup and no way to export any of it first.
        </p>

        <p className="font-label-sm text-outline uppercase tracking-widest mb-2">What is deleted</p>
        <ul className="mb-4 space-y-1">
          {DELETED_ON_ACCOUNT_DELETION.map((item) => (
            <li key={item} className="font-body-md text-on-surface leading-snug">
              {item}
            </li>
          ))}
        </ul>

        <p className="font-label-sm text-outline uppercase tracking-widest mb-2">What we have to keep</p>
        <ul className="mb-4 space-y-2">
          {RETAINED_ON_ACCOUNT_DELETION.map(({ item, reason }) => (
            <li key={item}>
              <p className="font-body-md text-on-surface leading-snug">{item}</p>
              <p className="font-label-sm text-on-surface-variant text-[12px] leading-snug">{reason}</p>
            </li>
          ))}
        </ul>

        <label htmlFor="delete-confirm" className="block font-label-sm text-on-surface mb-1">
          Type <span className="font-mono font-medium">{DELETION_CONFIRMATION_PHRASE}</span> to confirm
        </label>
        <input
          id="delete-confirm"
          type="text"
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          autoComplete="off"
          className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 font-body-md text-on-surface mb-3"
        />

        {error && (
          <p role="alert" className="font-label-sm text-error mb-3 leading-snug">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="bg-error text-on-error rounded-xl px-5 py-3 font-label-md disabled:opacity-50"
          >
            {submitting ? 'Deleting…' : 'Delete everything'}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setPhrase('')
              setError(null)
              router.refresh()
            }}
            disabled={submitting}
            className="font-label-md text-on-surface-variant disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
