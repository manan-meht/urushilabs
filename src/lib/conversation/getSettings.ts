/**
 * Server-only: the one way to read conversation settings for a case.
 *
 * Every AI entry point goes through here rather than reading `cases` columns
 * directly, so that normalization, the profanity/personality invariant, and the
 * acceptance rules are applied in exactly one place. A caller that reads the
 * columns itself would be a second, subtly different implementation of the rules
 * — which is how a setting ends up honoured in the live session and ignored in
 * the report.
 *
 * Never import from client components.
 */

import { getServiceClient } from '@/lib/db/client'
import {
  conversationSettingsFromRow,
  DEFAULT_CONVERSATION_SETTINGS,
  type ConversationSettings,
} from './settings'
import {
  effectiveSettings,
  evaluateAcceptance,
  type AcceptanceStatus,
  type SettingsAcceptance,
} from './acceptance'
import { expectedRefsForCase } from './participants'

export interface ResolvedConversationSettings {
  /** What the case has configured, before acceptance is taken into account. */
  configured: ConversationSettings
  /**
   * What should actually drive the AI. Identical to `configured` except that
   * profanity is forced off unless every expected participant accepted it.
   */
  effective: ConversationSettings
  acceptance: AcceptanceStatus
}

/**
 * Reads and resolves settings for a case.
 *
 * `expectedRefs` is who must agree. OMITTING it resolves them for the case's
 * mode, which is what almost every caller wants — passing an explicit list is
 * only for a caller that already knows the set and wants to avoid the lookup.
 *
 * The default is deliberately the safe one. An earlier pass through the async
 * entry points passed no refs at all, which silently meant "nobody needs to
 * agree" and resolved profanity as CONFIGURED rather than as ACCEPTED — making
 * the whole acceptance model decorative in exactly the paths nobody watches. A
 * default that has to be opted out of cannot fail that way.
 */
export async function getConversationSettings(
  caseId: string,
  expectedRefs?: readonly string[]
): Promise<ResolvedConversationSettings> {
  const refs = expectedRefs ?? await expectedRefsForCase(caseId)
  const db = getServiceClient()

  const [{ data: caseRow }, { data: acceptanceRows }] = await Promise.all([
    db
      .from('cases')
      .select('conversation_language, mediator_personality, allow_profanity, text_script, conversation_settings_version')
      .eq('id', caseId)
      .maybeSingle(),
    db
      .from('conversation_settings_acceptances')
      .select('participant_ref, settings_version, accepted_profanity, declined_at')
      .eq('case_id', caseId),
  ])

  // A missing case is not this module's error to raise — callers already resolve
  // and authorise the case before asking for its settings. Defaults keep prompt
  // construction working rather than throwing deep inside an AI call.
  const configured = caseRow ? conversationSettingsFromRow(caseRow) : DEFAULT_CONVERSATION_SETTINGS

  const acceptances: SettingsAcceptance[] = (acceptanceRows ?? []).map((r) => ({
    participantRef: r.participant_ref as string,
    settingsVersion: r.settings_version as number,
    acceptedProfanity: r.accepted_profanity === true,
    declinedAt: r.declined_at as string | null,
  }))

  const acceptance = evaluateAcceptance(configured, refs, acceptances)

  return {
    configured,
    effective: effectiveSettings(configured, acceptance),
    acceptance,
  }
}

/**
 * Settings only — for the many callers that just need to build a prompt and have
 * no acceptance decision to make (summaries, reports, a private intake).
 *
 * Still routed through the acceptance check, so profanity that was never agreed
 * to cannot leak into a report even though nobody is being asked to agree here.
 */
export async function getEffectiveSettings(
  caseId: string,
  expectedRefs?: readonly string[]
): Promise<ConversationSettings> {
  const { effective } = await getConversationSettings(caseId, expectedRefs)
  return effective
}
