import { NextRequest, NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/db/client'
import { decryptSummaryFromDb } from '@/lib/crypto'
import { runAnalysis } from '@/lib/ai/analysis'
import { MEDIATION_PROMPT_VERSION } from '@/lib/ai/analysis'
import { getEffectiveSettings } from '@/lib/conversation/getSettings'
import { sendNotification } from '@/lib/notifications'
import type { DbSubmission } from '@/lib/db/types'

interface RouteParams {
  params: Promise<{ id: string }>
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id: caseId } = await params

  // Verify CRON_SECRET or session
  const cronSecret = process.env['CRON_SECRET']
  const authHeader = req.headers.get('authorization')
  const isCronRequest = cronSecret && authHeader === `Bearer ${cronSecret}`

  if (!isCronRequest) {
    // Check if request comes from a valid session on this case
    const { getSession } = await import('@/lib/auth/session')
    const session = await getSession()
    if (!session || session.caseId !== caseId) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
    }
  }

  const db = getServiceClient()

  // Atomic status update — only one analysis job can run
  const { data: caseRow, error: caseError } = await db
    .from('cases')
    .select('id, topic, initiator_name, recipient_name, status')
    .eq('id', caseId)
    .single()

  if (caseError || !caseRow) {
    return NextResponse.json({ error: 'Case not found.' }, { status: 404 })
  }

  if (caseRow.status !== 'ready_for_analysis') {
    return NextResponse.json(
      { error: `Cannot analyse case in status: ${caseRow.status}` },
      { status: 409 }
    )
  }

  // Transition to 'analysing' atomically
  const { data: updated } = await db
    .from('cases')
    .update({ status: 'analysing', analysis_started_at: new Date().toISOString() })
    .eq('id', caseId)
    .eq('status', 'ready_for_analysis')
    .select('id')
    .single()

  if (!updated) {
    return NextResponse.json({ error: 'Another analysis is already in progress.' }, { status: 409 })
  }

  // Upsert analysis record — handles retries where a failed record already exists
  await db.from('analyses').delete().eq('case_id', caseId).in('status', ['failed', 'running'])

  const { data: analysisRow } = await db
    .from('analyses')
    .insert({
      case_id: caseId,
      status: 'running',
      prompt_version: MEDIATION_PROMPT_VERSION,
    })
    .select('id')
    .single()

  if (!analysisRow) {
    return NextResponse.json({ error: 'Failed to create analysis record.' }, { status: 500 })
  }

  try {
    // Fetch both participants
    const { data: participants } = await db
      .from('participants')
      .select('id, role')
      .eq('case_id', caseId)

    const initiatorParticipant = participants?.find((p) => p.role === 'initiator')
    const recipientParticipant = participants?.find((p) => p.role === 'recipient')

    if (!initiatorParticipant || !recipientParticipant) {
      throw new Error('Both participants must exist to run analysis.')
    }

    // Decrypt submissions server-side only
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

    const initiatorSummary = submissionMap.get(initiatorParticipant.id)
    const recipientSummary = submissionMap.get(recipientParticipant.id)

    if (!initiatorSummary || !recipientSummary) {
      throw new Error('Both submissions must be present to run analysis.')
    }

    const settings = await getEffectiveSettings(caseId)

    // Run analysis (decrypted summaries only in memory, never logged)
    const { report, inputTokens: analysisInputTokens, outputTokens: analysisOutputTokens } = await runAnalysis({
      initiatorName: caseRow.initiator_name,
      recipientName: caseRow.recipient_name,
      topic: caseRow.topic,
      initiatorSummary,
      recipientSummary,
      settings,
    })

    if (analysisInputTokens > 0 || analysisOutputTokens > 0) {
      void (async () => {
        try {
          const { error } = await db.rpc('increment_case_token_usage', {
            p_case_id: caseId,
            p_input_tokens: analysisInputTokens,
            p_output_tokens: analysisOutputTokens,
          })
          if (error) console.error('[analyse] token usage update failed:', error)
        } catch (err) { console.error('[analyse] token usage update threw:', err) }
      })()
    }

    // Determine if safety-sensitive
    const safetySensitive = [
      'possible_coercion_or_abuse',
      'possible_self_harm_or_violence',
      'possible_child_safety_issue',
      'legal_or_professional_support_needed',
    ].includes(report.safetyCategory)

    const finalStatus = safetySensitive ? 'needs_safety_review' : 'report_ready'

    // Store results
    await db
      .from('analyses')
      .update({
        status: 'complete',
        model: process.env['OPENAI_MODEL'] ?? 'gpt-4o',
        structured_result: report,
        safety_category: report.safetyCategory,
        safety_explanation: report.safetyExplanation,
      })
      .eq('id', analysisRow.id)

    await db
      .from('cases')
      .update({
        status: finalStatus,
        analysis_completed_at: new Date().toISOString(),
      })
      .eq('id', caseId)

    // Create agreement items from workingAgreements
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

    // Notify both participants (best-effort)
    for (const p of participants ?? []) {
      const { data: participantRow } = await db
        .from('participants')
        .select('display_name, email, phone')
        .eq('id', p.id)
        .single()

      if (!participantRow) continue

      const appUrl = process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000'
      const reportLink = `${appUrl}/case/${caseRow.id}/report`

      if (participantRow.phone) {
        await sendNotification({
          caseId,
          participantId: p.id,
          channel: 'whatsapp',
          template: 'report_ready',
          to: participantRow.phone,
          recipientName: participantRow.display_name,
          initiatorName: caseRow.initiator_name,
          topic: caseRow.topic,
          link: reportLink,
          caseReference: caseId,
        })
      }

      if (participantRow.email) {
        await sendNotification({
          caseId,
          participantId: p.id,
          channel: 'email',
          template: 'report_ready',
          to: participantRow.email,
          recipientName: participantRow.display_name,
          initiatorName: caseRow.initiator_name,
          topic: caseRow.topic,
          link: reportLink,
          caseReference: caseId,
        })
      }
    }

    return NextResponse.json({ success: true, status: finalStatus })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    console.error('[POST /api/cases/[id]/analyse] Analysis failed:', errorMessage)

    await db.from('analyses').update({
      status: 'failed',
      error_message: errorMessage,
    }).eq('id', analysisRow.id)

    await db.from('cases').update({ status: 'ready_for_analysis' }).eq('id', caseId)

    return NextResponse.json({ error: 'Analysis failed. You can retry.', detail: errorMessage }, { status: 500 })
  }
}
