import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { getServiceClient } from '@/lib/db/client'
import { encryptSummaryToDb, decryptSummaryFromDb } from '@/lib/crypto'
import { IntakeCompleteSchema } from '@/lib/validation/schemas'
import { runAnalysis, MEDIATION_PROMPT_VERSION } from '@/lib/ai/analysis'
import { getEffectiveSettings } from '@/lib/conversation/getSettings'
import type { DbSubmission } from '@/lib/db/types'
import { getCloudflareContext } from '@opennextjs/cloudflare'

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const parsed = IntakeCompleteSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 422 })
  }

  const { summary, consented } = parsed.data
  if (!consented) {
    return NextResponse.json({ error: 'Consent is required.' }, { status: 422 })
  }

  const { participantId, caseId } = session

  try {
    const db = getServiceClient()

    // Check not already completed
    const { data: participant } = await db
      .from('participants')
      .select('intake_completed_at')
      .eq('id', participantId)
      .single()

    if (participant?.intake_completed_at) {
      return NextResponse.json({ error: 'Intake already completed.' }, { status: 409 })
    }

    // Encrypt and store the summary
    const encrypted = encryptSummaryToDb(summary)
    await db.from('submissions').insert({
      case_id: caseId,
      participant_id: participantId,
      encrypted_summary: encrypted.encrypted_summary,
      encryption_iv: encrypted.encryption_iv,
      encryption_tag: encrypted.encryption_tag,
      consented_for_shared_analysis: true,
      revision_number: 1,
    })

    // Mark intake as complete
    await db
      .from('participants')
      .update({ intake_completed_at: new Date().toISOString() })
      .eq('id', participantId)

    // Audit
    await db.from('audit_events').insert({
      case_id: caseId,
      participant_id: participantId,
      event_type: 'intake_completed',
      metadata: null,
    })

    // For the initiator: redirect to the brief review page.
    // Brief generation happens there directly (not via background task).
    if (session.role === 'initiator') {
      return NextResponse.json({ success: true, readyForAnalysis: false, briefPending: true })
    }

    // Check if both participants have now completed their intake
    const { data: participants } = await db
      .from('participants')
      .select('id, role, intake_completed_at')
      .eq('case_id', caseId)

    const allComplete =
      participants &&
      participants.length === 2 &&
      participants.every((p) => !!p.intake_completed_at)

    if (allComplete) {
      // Atomically transition to analysing — only proceeds if not already picked up
      const { data: caseRow } = await db
        .from('cases')
        .update({ status: 'analysing', analysis_started_at: new Date().toISOString() })
        .in('status', ['awaiting_recipient', 'ready_for_analysis'])
        .eq('id', caseId)
        .select('id, topic, initiator_name, recipient_name')
        .single()

      if (caseRow) {
        await db.from('audit_events').insert({
          case_id: caseId,
          event_type: 'ready_for_analysis',
          metadata: null,
        })

        // Create analysis record
        const { data: analysisRow } = await db
          .from('analyses')
          .insert({ case_id: caseId, status: 'running', prompt_version: MEDIATION_PROMPT_VERSION })
          .select('id')
          .single()

        if (analysisRow) {
          // Register with Cloudflare ctx.waitUntil so the Worker stays alive
          // after the response is sent, long enough to complete the analysis.
          let cfCtx: { waitUntil: (p: Promise<unknown>) => void } | null = null
          try { cfCtx = getCloudflareContext().ctx } catch { /* local dev — no CF context */ }

          const analysisPromise = (async () => {
            try {
              const { data: participantRows } = await db
                .from('participants')
                .select('id, role')
                .eq('case_id', caseId)

              const initiatorP = participantRows?.find((p) => p.role === 'initiator')
              const recipientP = participantRows?.find((p) => p.role === 'recipient')
              if (!initiatorP || !recipientP) throw new Error('Missing participants')

              const { data: submissions } = await db
                .from('submissions')
                .select('participant_id, encrypted_summary, encryption_iv, encryption_tag')
                .eq('case_id', caseId)
                .order('revision_number', { ascending: false })

              const submissionMap = new Map<string, string>()
              for (const sub of (submissions as DbSubmission[] ?? [])) {
                if (!submissionMap.has(sub.participant_id)) {
                  submissionMap.set(sub.participant_id, decryptSummaryFromDb(sub))
                }
              }

              const initiatorSummary = submissionMap.get(initiatorP.id)
              const recipientSummary = submissionMap.get(recipientP.id)
              if (!initiatorSummary || !recipientSummary) throw new Error('Missing submissions')

              // The same analysis reached through /api/cases/[id]/analyse has
              // always passed these; this path never did, so an invited case
              // that chose the Straight Shooter was analysed by a mediator with
              // no personality, language or register at all — silently, since
              // the persona was omitted rather than defaulted.
              const conversationSettings = await getEffectiveSettings(caseId)

              const { report, inputTokens: analysisInputTokens, outputTokens: analysisOutputTokens } = await runAnalysis({
                initiatorName: caseRow.initiator_name,
                recipientName: caseRow.recipient_name,
                topic: caseRow.topic,
                initiatorSummary,
                recipientSummary,
                settings: conversationSettings,
              })

              if (analysisInputTokens > 0 || analysisOutputTokens > 0) {
                void (async () => {
                  try {
                    const { error } = await db.rpc('increment_case_token_usage', {
                      p_case_id: caseId,
                      p_input_tokens: analysisInputTokens,
                      p_output_tokens: analysisOutputTokens,
                    })
                    if (error) console.error('[intake/complete] token usage update failed:', error)
                  } catch (err) { console.error('[intake/complete] token usage update threw:', err) }
                })()
              }

              const safetySensitive = [
                'possible_coercion_or_abuse',
                'possible_self_harm_or_violence',
                'possible_child_safety_issue',
                'legal_or_professional_support_needed',
              ].includes(report.safetyCategory)

              const finalStatus = safetySensitive ? 'needs_safety_review' : 'report_ready'

              await db.from('analyses').update({
                status: 'complete',
                model: process.env['OPENAI_MODEL'] ?? 'gpt-4o',
                structured_result: report,
                safety_category: report.safetyCategory,
                safety_explanation: report.safetyExplanation,
              }).eq('id', analysisRow.id)

              await db.from('cases').update({
                status: finalStatus,
                analysis_completed_at: new Date().toISOString(),
              }).eq('id', caseId)

              const agreements = report.workingAgreements.map((w) => w.agreement)
              if (agreements.length > 0) {
                await db.from('agreements').insert(
                  agreements.map((text: string) => ({
                    case_id: caseId,
                    analysis_id: analysisRow.id,
                    agreement_text: text,
                  }))
                )
              }

              await db.from('audit_events').insert({
                case_id: caseId,
                event_type: 'analysis_complete',
                metadata: { safety_category: report.safetyCategory },
              })
            } catch (err) {
              console.error('[intake/complete] Analysis failed:', err)
              await db.from('analyses').update({ status: 'failed', error_message: String(err) }).eq('id', analysisRow.id)
              await db.from('cases').update({ status: 'ready_for_analysis' }).eq('id', caseId)
            }
          })()

          if (cfCtx) {
            cfCtx.waitUntil(analysisPromise)
          }
        }
      }
    }

    return NextResponse.json({ success: true, readyForAnalysis: allComplete ?? false })
  } catch (err) {
    console.error('[POST /api/intake/complete] Error:', err)
    return NextResponse.json({ error: 'Failed to complete intake.' }, { status: 500 })
  }
}
