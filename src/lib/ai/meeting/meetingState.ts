/**
 * Pure state-transition helpers for meeting mediation state (issues, agreements).
 * Mirrors src/lib/ai/room/roomState.ts exactly — kept as an independent copy so
 * Live Mediation's file is never touched by this work. No I/O — callers persist
 * the results.
 */

import type { IssueStatus } from '@/lib/db/types'

export type IssueEvent = 'start_discussing' | 'mark_agreed' | 'mark_partial' | 'mark_unresolved' | 'skip'

const ISSUE_TRANSITIONS: Record<IssueStatus, Partial<Record<IssueEvent, IssueStatus>>> = {
  pending: { start_discussing: 'discussing', skip: 'skipped' },
  discussing: {
    mark_agreed: 'agreed',
    mark_partial: 'partial',
    mark_unresolved: 'unresolved',
    skip: 'skipped',
  },
  agreed: {},
  partial: { start_discussing: 'discussing', mark_agreed: 'agreed' },
  unresolved: { start_discussing: 'discussing', skip: 'skipped' },
  skipped: { start_discussing: 'discussing' },
}

export function nextIssueStatus(current: IssueStatus, event: IssueEvent): IssueStatus {
  return ISSUE_TRANSITIONS[current]?.[event] ?? current
}

export interface AgreementAffirmationState {
  agreedBy: string[]
  awaiting: string[]
}

export interface AgreementAffirmationResult extends AgreementAffirmationState {
  confirmed: boolean
}

/**
 * Records one participant's explicit affirmation of a proposed agreement. Agreement
 * is only ever confirmed once every awaited participant has explicitly affirmed —
 * never inferred from silence or the passage of time (spec §25).
 */
export function affirmAgreement(
  state: AgreementAffirmationState,
  participantId: string
): AgreementAffirmationResult {
  const agreedBy = state.agreedBy.includes(participantId) ? state.agreedBy : [...state.agreedBy, participantId]
  const awaiting = state.awaiting.filter((id) => id !== participantId)
  return { agreedBy, awaiting, confirmed: awaiting.length === 0 }
}

export function createAgreementState(participantIds: string[]): AgreementAffirmationState {
  return { agreedBy: [], awaiting: [...participantIds] }
}
