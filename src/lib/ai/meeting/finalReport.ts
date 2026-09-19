/**
 * Server-only: generates the final report at the end of a Meeting Mediation
 * session. Mirrors src/lib/ai/room/finalReport.ts's rules and shape exactly (same
 * RoomFinalReport-compatible output — see MeetingFinalReport type alias in
 * src/lib/db/types.ts) so the report pipeline and UI can be shared. Kept as an
 * independent copy so Live Mediation's file is never touched by this work.
 */

import { z } from 'zod'
import { getEnv } from '@/lib/env'
import { buildMediatorPersona, buildPersonaLanguageReminder } from '@/lib/ai/persona'
import type { ConversationSettings } from '@/lib/conversation/settings'
import type { MeetingFinalReport, SafetyCategory } from '@/lib/db/types'

const FinalReportSchema = z.object({
  whatHappened: z.string().min(1),
  agreed: z.array(z.object({ title: z.string().min(1), description: z.string().min(1) })),
  unresolved: z.array(z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    suggestedNextStep: z.string().min(1),
  })),
  participantActions: z.array(z.object({
    participantName: z.string().min(1),
    actions: z.array(z.string().min(1)),
  })),
  nextSteps: z.array(z.string().min(1)),
  safetyCategory: z.enum([
    'ordinary_conflict', 'high_conflict', 'possible_coercion_or_abuse',
    'possible_self_harm_or_violence', 'possible_child_safety_issue',
    'legal_or_professional_support_needed',
  ]),
  safetyNote: z.string().optional(),
})

export interface MeetingFinalReportContext {
  topic: string
  contextSummary?: string
  participantNames: string[]
  conversationSummary: string
  issueResolutions: Array<{ title: string; status: string; resolution?: string }>
  confirmedAgreements: string[]
  transcriptExcerpt: Array<{ speakerName: string; content: string }>
  /**
   * Optional so that callers with no case to read settings from keep the
   * pre-persona behaviour exactly.
   */
  settings?: ConversationSettings
}

export interface MeetingFinalReportResult {
  report: MeetingFinalReport
  inputTokens: number
  outputTokens: number
}

export async function generateMeetingFinalReport(ctx: MeetingFinalReportContext): Promise<MeetingFinalReportResult> {
  const { OPENAI_API_KEY, OPENAI_MODEL, DEMO_MODE } = getEnv()

  if (DEMO_MODE) {
    return {
      report: {
        whatHappened: `${ctx.participantNames.join(' and ')} discussed ${ctx.topic} together on a video call, with Urushi listening in and stepping in occasionally to help clarify points and capture agreements.`,
        agreed: [{
          title: 'Ongoing communication',
          description: 'Both sides agreed to raise concerns directly and promptly rather than letting them build up.',
        }],
        unresolved: [],
        participantActions: ctx.participantNames.map((name) => ({
          participantName: name,
          actions: ['Follow up on what was agreed within the next week.'],
        })),
        nextSteps: ['Check in with each other in a week to see how the agreement is working.'],
        safetyCategory: 'ordinary_conflict',
      },
      inputTokens: 0,
      outputTokens: 0,
    }
  }

  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.')

  const issueText = ctx.issueResolutions
    .map((i) => `Issue: ${i.title}\nStatus: ${i.status}${i.resolution ? `\nResolution: ${i.resolution}` : ''}`)
    .join('\n\n')

  const transcriptText = ctx.transcriptExcerpt.map((t) => `${t.speakerName}: ${t.content}`).join('\n')

  // The meeting itself was spoken, but the report is read — hence written: true.
  const persona = ctx.settings ? `${buildMediatorPersona(ctx.settings, { written: true, record: true })}\n\n` : ''
  // Only works in final position, which is why it is appended rather than folded
  // into the persona block above.
  const languageReminder = ctx.settings ? buildPersonaLanguageReminder(ctx.settings) : ''

  const system = `${persona}You are a neutral conflict-resolution facilitator producing the final report after a Meeting Mediation session (a video call) with ${ctx.participantNames.length} participants: ${ctx.participantNames.join(', ')}.

# Rules
- Do NOT invent agreements that were not expressed or confirmed
- Do NOT assign blame
- This is a resolution-focused report, NOT generic meeting notes — do not summarize the whole call chronologically
- "whatHappened" is a short, neutral 2-4 sentence assessment of the disagreement and how the conversation went
- "agreed" only includes agreements that were explicitly confirmed by the relevant participants
- "unresolved" only if applicable — describe neutrally, with a concrete suggested next step
- "participantActions" gives specific, behavioural next actions for each named participant
- "nextSteps" is a short numbered list of concrete next actions
- Identify safety category honestly (ordinary_conflict is appropriate for normal disagreement)
- safetyNote required only if category is not ordinary_conflict

# Output — JSON only, no preamble, no markdown fences
{
  "whatHappened": "...",
  "agreed": [{ "title": "...", "description": "..." }],
  "unresolved": [{ "title": "...", "description": "...", "suggestedNextStep": "..." }],
  "participantActions": [{ "participantName": "...", "actions": ["..."] }],
  "nextSteps": ["..."],
  "safetyCategory": "ordinary_conflict",
  "safetyNote": "..."
}${languageReminder ? `\n\n${languageReminder}` : ''}`

  const user = `Topic: ${ctx.topic}
${ctx.contextSummary ? `Background: ${ctx.contextSummary}\n` : ''}
Conversation summary: ${ctx.conversationSummary}

Issue resolutions:
${issueText || '(none tracked)'}

Confirmed agreements:
${ctx.confirmedAgreements.join('\n') || '(none)'}

Transcript excerpt:
${transcriptText}`

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      max_tokens: 2500,
      temperature: 0.3,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OpenAI meeting final report failed (${res.status}): ${text}`)
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens: number; completion_tokens: number }
  }

  const raw = data.choices?.[0]?.message?.content
  if (!raw) throw new Error('Empty response from OpenAI.')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('OpenAI returned invalid JSON for meeting final report.')
  }

  const validated = FinalReportSchema.safeParse(parsed)
  if (!validated.success) {
    throw new Error(`Meeting final report schema validation failed: ${validated.error.message}`)
  }

  return {
    report: validated.data as MeetingFinalReport & { safetyCategory: SafetyCategory },
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  }
}
