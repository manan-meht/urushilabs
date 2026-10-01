/**
 * One transactional email through Resend, with the caller's own subject and
 * HTML. The template-based EmailProvider covers the fixed notifications; this
 * is for content composed at request time, such as a meeting report.
 *
 * Server-only. Never throws: the result says what happened.
 */

import { getEnv } from '@/lib/env'

export interface SendEmailInput {
  to: string[]
  subject: string
  html: string
  text?: string
  replyTo?: string
}

export type SendEmailResult =
  | { ok: true; providerId?: string }
  | { ok: false; error: string; notConfigured?: boolean }

export function isEmailConfigured(): boolean {
  const { RESEND_API_KEY, EMAIL_FROM } = getEnv()
  return Boolean(RESEND_API_KEY && RESEND_API_KEY !== 're_placeholder' && EMAIL_FROM)
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const { RESEND_API_KEY, EMAIL_FROM } = getEnv()
  if (!isEmailConfigured()) return { ok: false, error: 'Email is not configured.', notConfigured: true }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: input.to,
        subject: input.subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    })
    const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string }
    if (!res.ok) return { ok: false, error: `Email API error ${res.status}${data.message ? `: ${data.message}` : ''}` }
    return { ok: true, ...(data.id ? { providerId: data.id } : {}) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error sending email.' }
  }
}
