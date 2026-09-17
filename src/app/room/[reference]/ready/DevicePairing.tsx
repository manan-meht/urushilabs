'use client'

import { useEffect, useState } from 'react'

interface Props {
  sessionId: string
}

interface PairedDevice {
  id: string
  label: string | null
  paired_at: string
  last_seen_at: string | null
  revoked_at: string | null
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'never'
  const diffMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(iso).toLocaleDateString()
}

export function DevicePairing({ sessionId }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [devices, setDevices] = useState<PairedDevice[]>([])
  const [label, setLabel] = useState('')
  const [pairing, setPairing] = useState(false)
  const [newToken, setNewToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedSessionId, setCopiedSessionId] = useState(false)
  const [error, setError] = useState('')

  async function loadDevices() {
    try {
      const res = await fetch(`/api/room/sessions/${sessionId}/devices`)
      if (!res.ok) return
      const data = await res.json() as { devices: PairedDevice[] }
      setDevices(data.devices.filter((d) => !d.revoked_at))
    } catch {
      // Best-effort — the pairing flow itself still works without the list.
    }
  }

  useEffect(() => {
    if (expanded) void loadDevices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded])

  async function handlePair() {
    setPairing(true)
    setError('')
    setNewToken(null)
    try {
      const res = await fetch(`/api/room/sessions/${sessionId}/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim() || undefined }),
      })
      const data = await res.json() as { token?: string; error?: string }
      if (!res.ok) {
        setError(data.error ?? 'Failed to pair device.')
        return
      }
      setNewToken(data.token ?? null)
      setLabel('')
      await loadDevices()
    } catch {
      setError('A network error occurred. Please try again.')
    } finally {
      setPairing(false)
    }
  }

  async function handleRevoke(deviceId: string) {
    try {
      await fetch(`/api/room/sessions/${sessionId}/devices/${deviceId}`, { method: 'DELETE' })
      await loadDevices()
    } catch {
      // Best-effort — device list will show it as still active until retried.
    }
  }

  /**
   * A single copy-paste-able command that writes both the session ID and the token
   * straight into the device's .env. Deliberately replaces showing a bare token:
   * in real use, a raw secret sitting next to a text input got pasted into the
   * wrong field (the device label), into a chat window, and a stale one got hand-
   * copied into .env — three separate mix-ups. One command, one destination,
   * no decisions to get wrong.
   */
  const setupCommand = newToken
    ? [
        'cd ~/urushi-pi-client && \\',
        `  sed -i 's|^URUSHI_SESSION_ID=.*|URUSHI_SESSION_ID=${sessionId}|' .env && \\`,
        `  sed -i 's|^URUSHI_DEVICE_TOKEN=.*|URUSHI_DEVICE_TOKEN=${newToken}|' .env`,
      ].join('\n')
    : ''

  async function copySetupCommand() {
    if (!setupCommand) return
    await navigator.clipboard.writeText(setupCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  async function copySessionId() {
    await navigator.clipboard.writeText(sessionId)
    setCopiedSessionId(true)
    setTimeout(() => setCopiedSessionId(false), 2500)
  }

  return (
    <div className="mb-8 text-left">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between p-4 bg-surface-container-low rounded-xl border border-outline-variant/40 hover:border-tertiary/40 transition-all"
      >
        <span className="flex items-center gap-2 font-label-md text-on-surface-variant">
          <span className="material-symbols-outlined text-[20px] text-tertiary">memory</span>
          Pair a hardware device
          <span className="text-outline font-normal">(optional)</span>
        </span>
        <span className="material-symbols-outlined text-outline text-[20px]">
          {expanded ? 'expand_less' : 'expand_more'}
        </span>
      </button>

      {expanded && (
        <div className="mt-3 p-4 bg-surface-container-lowest rounded-xl border border-outline-variant/40 space-y-4">
          <p className="text-label-sm text-on-surface-variant leading-snug">
            Have a Raspberry Pi or other hardware client? Pair it here, then enter the session ID and token on the
            device. It will act as another client of this session — you can still use the browser too.
          </p>

          <div className="flex items-center justify-between gap-2 p-3 bg-surface-container-low rounded-xl border border-outline-variant/40">
            <div className="min-w-0">
              <p className="font-label-sm text-outline uppercase tracking-widest">Session ID</p>
              <p className="font-body-md text-on-surface text-sm truncate">{sessionId}</p>
            </div>
            <button
              type="button"
              onClick={() => void copySessionId()}
              className="shrink-0 px-3 py-2 border border-outline-variant rounded-xl font-label-md text-on-surface hover:bg-surface-container-lowest transition-all flex items-center gap-1.5 text-sm"
            >
              <span className="material-symbols-outlined text-[16px]">{copiedSessionId ? 'check' : 'content_copy'}</span>
              {copiedSessionId ? 'Copied!' : 'Copy'}
            </button>
          </div>

          {newToken && (
            <div className="p-4 bg-tertiary-container/20 border border-tertiary/30 rounded-xl space-y-3">
              <div>
                <p className="font-label-sm text-tertiary uppercase tracking-widest">
                  Device paired — run this on the device now
                </p>
                <p className="text-label-sm text-on-surface-variant leading-snug mt-1">
                  Copy the whole command and run it on the device. It contains the token, which won&apos;t be shown
                  again. Don&apos;t paste it anywhere else.
                </p>
              </div>

              <div className="flex gap-2">
                <pre className="flex-1 min-w-0 px-3 py-2.5 border border-outline-variant rounded-xl text-on-surface text-[11px] leading-relaxed bg-white overflow-x-auto whitespace-pre">
{setupCommand}
                </pre>
                <button
                  type="button"
                  onClick={() => void copySetupCommand()}
                  className="shrink-0 self-start px-4 py-2.5 border border-outline-variant rounded-xl font-label-md text-on-surface hover:bg-surface-container-low transition-all flex items-center gap-2"
                >
                  <span className="material-symbols-outlined text-[16px]">{copied ? 'check' : 'content_copy'}</span>
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="bg-error-container text-on-error-container p-3 rounded-xl font-body-md text-sm" role="alert">
              {error}
            </div>
          )}

          <div className="flex gap-2">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={80}
              placeholder="Device name (optional) — e.g. Living room Pi"
              className="flex-1 h-12 px-3 bg-white border border-outline-variant rounded-xl focus:border-tertiary focus:ring-1 focus:ring-tertiary outline-none transition-all text-sm placeholder:text-outline/50"
            />
            <button
              type="button"
              onClick={() => void handlePair()}
              disabled={pairing}
              className="shrink-0 px-5 h-12 bg-tertiary text-white rounded-xl font-label-md hover:opacity-90 transition-all disabled:opacity-60"
            >
              {pairing ? 'Pairing…' : 'Pair device'}
            </button>
          </div>

          {devices.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-outline-variant/30">
              <p className="font-label-sm text-outline uppercase tracking-widest">Paired devices</p>
              {devices.map((d) => (
                <div key={d.id} className="flex items-center justify-between py-1.5">
                  <div>
                    <p className="font-body-md text-on-surface">{d.label || 'Unnamed device'}</p>
                    <p className="text-label-sm text-outline">Last seen {formatWhen(d.last_seen_at)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleRevoke(d.id)}
                    className="text-label-sm text-error hover:underline"
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
