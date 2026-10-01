/**
 * The meeting report as an email.
 *
 * The report page itself is owner-only, so a link alone would bounce every
 * recipient to a login they do not have. The email carries the full report
 * inline, in the language it was written in, with the sender as reply-to so
 * replies go to a person rather than a no-reply address.
 */

import { z } from 'zod'
import type { MeetingFinalReport } from '@/lib/db/types'

export const MAX_RECIPIENTS = 10

export const EmailReportRequestSchema = z.object({
  recipients: z
    .array(z.string().trim().toLowerCase().email('Not a valid email address.'))
    .min(1, 'Add at least one recipient.')
    .max(MAX_RECIPIENTS, `At most ${MAX_RECIPIENTS} recipients per email.`)
    .transform((list) => Array.from(new Set(list))),
  note: z.string().trim().max(600, 'Keep the note under 600 characters.').optional(),
})

export type EmailReportRequest = z.infer<typeof EmailReportRequestSchema>

export interface ReportEmailContext {
  topic: string
  participantNames: string[]
  /** ISO timestamp the meeting ended, if known. */
  endedAt: string | null
  /** The owner who is sharing it; shown as the sender and used as reply-to. */
  senderEmail: string
  note?: string
  appUrl: string
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

export function renderMeetingReportEmail(report: MeetingFinalReport, ctx: ReportEmailContext): { subject: string; html: string; text: string } {
  const e = escapeHtml
  const date = formatDate(ctx.endedAt)
  const subject = `Meeting report: ${ctx.topic}`

  const heading = (t: string) =>
    `<p style="margin:28px 0 8px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#737972;">${e(t)}</p>`
  const para = (t: string) => `<p style="margin:0 0 10px;font-size:15px;line-height:1.6;color:#1a1c1b;">${e(t)}</p>`

  const sections: string[] = []
  const textParts: string[] = [`MEETING REPORT: ${ctx.topic}`, date ? `Meeting on ${date}` : '', `Participants: ${ctx.participantNames.join(', ')}`, '']

  if (ctx.note) {
    sections.push(`<div style="margin:0 0 20px;padding:14px 16px;background:#eef2ee;border-radius:10px;font-size:15px;line-height:1.6;color:#1a1c1b;">${e(ctx.note)}<br><span style="color:#737972;font-size:13px;">— ${e(ctx.senderEmail)}</span></div>`)
    textParts.push(`Note from ${ctx.senderEmail}: ${ctx.note}`, '')
  }

  if (report.safetyNote) {
    sections.push(`<div style="margin:0 0 20px;padding:14px 16px;background:#fdecea;border-radius:10px;font-size:14px;line-height:1.6;color:#5f1412;">${e(report.safetyNote)}</div>`)
    textParts.push(`Note: ${report.safetyNote}`, '')
  }

  sections.push(heading('What happened'), para(report.whatHappened))
  textParts.push('WHAT HAPPENED', report.whatHappened, '')

  if (report.agreed.length) {
    sections.push(heading('Agreements reached'), '<ul style="margin:0;padding-left:18px;">' + report.agreed.map((a) =>
      `<li style="margin:0 0 10px;font-size:15px;line-height:1.6;color:#1a1c1b;"><strong>${e(a.title)}</strong><br><span style="color:#4b4f4c;">${e(a.description)}</span></li>`).join('') + '</ul>')
    textParts.push('AGREEMENTS REACHED', ...report.agreed.map((a) => `- ${a.title}: ${a.description}`), '')
  }

  if (report.unresolved.length) {
    sections.push(heading('Still unresolved'), '<ul style="margin:0;padding-left:18px;">' + report.unresolved.map((u) =>
      `<li style="margin:0 0 10px;font-size:15px;line-height:1.6;color:#1a1c1b;"><strong>${e(u.title)}</strong><br><span style="color:#4b4f4c;">${e(u.description)}</span><br><span style="color:#4a654e;">Suggested next step: ${e(u.suggestedNextStep)}</span></li>`).join('') + '</ul>')
    textParts.push('STILL UNRESOLVED', ...report.unresolved.map((u) => `- ${u.title}: ${u.description} (Suggested next step: ${u.suggestedNextStep})`), '')
  }

  if (report.participantActions.length) {
    sections.push(heading('What each person should change'), report.participantActions.map((pa) =>
      `<p style="margin:10px 0 4px;font-size:15px;font-weight:600;color:#1a1c1b;">${e(pa.participantName)}</p><ul style="margin:0;padding-left:18px;">` +
      pa.actions.map((a) => `<li style="margin:0 0 4px;font-size:15px;line-height:1.6;color:#4b4f4c;">${e(a)}</li>`).join('') + '</ul>').join(''))
    textParts.push('WHAT EACH PERSON SHOULD CHANGE', ...report.participantActions.flatMap((pa) => [pa.participantName, ...pa.actions.map((a) => `  - ${a}`)]), '')
  }

  if (report.nextSteps.length) {
    sections.push(heading('Next steps'), '<ol style="margin:0;padding-left:18px;">' + report.nextSteps.map((s) =>
      `<li style="margin:0 0 6px;font-size:15px;line-height:1.6;color:#4b4f4c;">${e(s)}</li>`).join('') + '</ol>')
    textParts.push('NEXT STEPS', ...report.nextSteps.map((s, i) => `${i + 1}. ${s}`), '')
  }

  const html = `<!DOCTYPE html><html><body style="margin:0;background:#faf9f7;padding:32px 16px;font-family:Inter,Helvetica,Arial,sans-serif;">
<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e3e5e2;border-radius:14px;padding:32px;">
  <p style="margin:0 0 6px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#4a654e;">Urushi Labs · Meeting report</p>
  <h1 style="margin:0 0 6px;font-size:22px;line-height:1.3;color:#1a1c1b;">${e(ctx.topic)}</h1>
  <p style="margin:0 0 4px;font-size:14px;color:#737972;">${date ? `Meeting on ${e(date)} · ` : ''}${e(ctx.participantNames.join(', '))}</p>
  <p style="margin:0 0 20px;font-size:13px;color:#737972;">Shared by ${e(ctx.senderEmail)}</p>
  ${sections.join('\n')}
  <hr style="border:none;border-top:1px solid #e3e5e2;margin:28px 0 16px;">
  <p style="margin:0;font-size:12px;line-height:1.6;color:#737972;">This report was written by Urushi, an AI mediator, from what was said in the meeting. It is a communication aid, not legal, therapeutic or professional advice. <a href="${e(ctx.appUrl)}" style="color:#4a654e;">urushilabs.com</a></p>
</div></body></html>`

  textParts.push('--', 'Written by Urushi, an AI mediator, from what was said in the meeting. A communication aid, not legal, therapeutic or professional advice.', ctx.appUrl)
  return { subject, html, text: textParts.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') }
}
