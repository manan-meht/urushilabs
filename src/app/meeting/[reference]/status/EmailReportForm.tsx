'use client'

import { useState } from 'react'

interface Props {
  sessionId: string
  /** Participant emails we already know, offered as the default recipients. */
  suggestedRecipients: string[]
  onClose: () => void
}

/**
 * Sends the report by email to addresses the owner chooses. Participants'
 * known addresses are prefilled; anything else is typed in, comma or newline
 * separated. The server validates and caps the list.
 */
export function EmailReportForm({ sessionId, suggestedRecipients, onClose }: Props) {
  const [recipients, setRecipients] = useState(suggestedRecipients.join(', '))
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ ok: true; sent: number } | { ok: false; message: string } | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSending(true)
    setResult(null)
    const list = recipients.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)
    try {
      const res = await fetch(`/api/meeting/sessions/${sessionId}/report/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: list, ...(note.trim() ? { note: note.trim() } : {}) }),
      })
      const json = (await res.json().catch(() => ({}))) as { sent?: number; error?: string; message?: string }
      if (res.ok && typeof json.sent === 'number') {
        setResult({ ok: true, sent: json.sent })
      } else if (res.status === 503) {
        setResult({ ok: false, message: 'Email sending is not set up yet. Use Download PDF for now.' })
      } else {
        setResult({ ok: false, message: json.error ?? 'The email could not be sent.' })
      }
    } catch {
      setResult({ ok: false, message: 'The email could not be sent. Check your connection and try again.' })
    } finally {
      setSending(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="bg-surface-container-low rounded-xl border border-outline-variant/40 p-5 space-y-3">
      <p className="font-label-sm text-outline uppercase tracking-widest">Email this report</p>
      <label className="block">
        <span className="font-body-sm text-on-surface-variant">Recipients</span>
        <textarea
          value={recipients}
          onChange={(e) => setRecipients(e.target.value)}
          rows={2}
          placeholder="name@example.com, other@example.com"
          className="mt-1 w-full rounded-lg border border-outline-variant bg-surface-container-lowest p-3 font-body-md text-on-surface"
          required
        />
      </label>
      <label className="block">
        <span className="font-body-sm text-on-surface-variant">Note (optional)</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={600}
          placeholder="A line to go above the report."
          className="mt-1 w-full rounded-lg border border-outline-variant bg-surface-container-lowest p-3 font-body-md text-on-surface"
        />
      </label>
      <p className="font-body-sm text-on-surface-variant">The full report goes in the email. Replies come to you.</p>
      {result && (
        <div
          role="status"
          className={result.ok ? 'bg-primary-container text-on-primary-container p-3 rounded-lg font-body-md' : 'bg-error-container text-on-error-container p-3 rounded-lg font-body-md'}
        >
          {result.ok ? `Sent to ${result.sent} ${result.sent === 1 ? 'address' : 'addresses'}.` : result.message}
        </div>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={sending} className="h-11 px-5 bg-primary text-on-primary rounded-xl font-bold text-body-md hover:opacity-90 transition-all disabled:opacity-60">
          {sending ? 'Sending…' : 'Send'}
        </button>
        <button type="button" onClick={onClose} className="h-11 px-4 rounded-xl border border-outline-variant text-on-surface-variant font-body-md hover:border-primary hover:text-primary transition-colors">
          Close
        </button>
      </div>
    </form>
  )
}
