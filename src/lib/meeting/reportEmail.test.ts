import { describe, it, expect } from 'vitest'
import { EmailReportRequestSchema, renderMeetingReportEmail, escapeHtml } from './reportEmail'
import type { MeetingFinalReport } from '@/lib/db/types'

const report: MeetingFinalReport = {
  whatHappened: 'Manan asked Binny to work the weekend; Binny declined & offered <materials>.',
  agreed: [{ title: 'Materials by Friday', description: 'Binny sends what she has.' }],
  unresolved: [{ title: 'Weekend work', description: 'Not agreed.', suggestedNextStep: 'Ask the VP to move the meeting.' }],
  participantActions: [{ participantName: 'Manan', actions: ['Stop framing requests as orders.'] }],
  nextSteps: ['Confirm the Monday slot.'],
  safetyCategory: 'ordinary_conflict',
}

const ctx = { topic: 'Weekend report', participantNames: ['Manan', 'Binny'], endedAt: '2026-09-30T10:01:00Z', senderEmail: 'owner@example.com', appUrl: 'https://urushilabs.com' }

describe('EmailReportRequestSchema', () => {
  it('normalises, de-duplicates and caps recipients', () => {
    const r = EmailReportRequestSchema.safeParse({ recipients: [' A@Example.com ', 'a@example.com', 'b@example.com'] })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.recipients).toEqual(['a@example.com', 'b@example.com'])
    expect(EmailReportRequestSchema.safeParse({ recipients: [] }).success).toBe(false)
    expect(EmailReportRequestSchema.safeParse({ recipients: ['not-an-email'] }).success).toBe(false)
    expect(EmailReportRequestSchema.safeParse({ recipients: Array.from({ length: 11 }, (_, i) => `u${i}@example.com`) }).success).toBe(false)
  })
})

describe('renderMeetingReportEmail', () => {
  it('carries the whole report inline and escapes it', () => {
    const { subject, html, text } = renderMeetingReportEmail(report, ctx)
    expect(subject).toBe('Meeting report: Weekend report')
    expect(html).toContain('&lt;materials&gt;')
    expect(html).not.toContain('<materials>')
    for (const s of ['What happened', 'Agreements reached', 'Still unresolved', 'What each person should change', 'Next steps', 'Materials by Friday', 'Ask the VP to move the meeting.', 'Confirm the Monday slot.', 'Shared by owner@example.com', '30 September 2026']) {
      expect(html).toContain(s)
    }
    expect(text).toContain('AGREEMENTS REACHED')
    expect(text).toContain('- Materials by Friday: Binny sends what she has.')
  })

  it('omits empty sections and includes the note when given', () => {
    const { html } = renderMeetingReportEmail({ ...report, agreed: [], nextSteps: [] }, { ...ctx, note: 'Sharing as discussed.' })
    expect(html).not.toContain('Agreements reached')
    expect(html).not.toContain('Next steps')
    expect(html).toContain('Sharing as discussed.')
  })

  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })
})
