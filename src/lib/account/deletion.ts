/**
 * Deleting an account, and the two decisions that guard it.
 *
 * The destructive work is one transactional SQL function,
 * delete_user_account() (migration 020) — see that migration for why it lives in
 * SQL and for the reasoning behind retaining `payments`. This module is the two
 * things around it that are worth deciding in one place and testing directly:
 *
 *  1. WHOSE account is being deleted. decideDeletion never reads an identifier
 *     from the request. There is exactly one source for the target — the
 *     authenticated session — so there is no code path, present or future, in
 *     which a request body can nominate a victim.
 *
 *  2. WHETHER they meant it. This destroys recorded arguments and encrypted
 *     private disclosures, irreversibly, and there is no export and no undo. A
 *     single click must not be able to do that, so the user types a phrase.
 *
 * The copy constants are here rather than in the page because they are the
 * honest description of what the SQL function actually does. Kept next to it so
 * that changing one and not the other is visible in a single file.
 */

import { getServiceClient } from '@/lib/db/client'

export const DELETION_CONFIRMATION_PHRASE = 'DELETE MY DATA'

/** What the user is told will be destroyed. Matches delete_user_account(). */
export const DELETED_ON_ACCOUNT_DELETION: readonly string[] = [
  'Every conversation you started, including the other person’s side of it',
  'Your private intake messages and submissions, and the reports written from them',
  'Live and meeting session recordings, transcripts and agreements',
  'Your name, email address and phone number',
  'Your remaining room and follow-up credits, which are not refunded',
  'Any paired room device',
]

/**
 * What survives, and why. Retention that is not explained reads as retention
 * that was not decided.
 */
export const RETAINED_ON_ACCOUNT_DELETION: readonly { item: string; reason: string }[] = [
  {
    item: 'A record of each payment: the amount, the date and the payment gateway’s reference.',
    reason:
      'Singapore law requires businesses to keep transaction records for five years. Your name and account are removed from these records, so they no longer identify you.',
  },
  {
    item: 'The date your account was deleted.',
    reason:
      'So we can show your deletion request was carried out. This record holds no name, email or case details.',
  },
  {
    item:
      'Conversations started by someone else that you took part in, with your messages and details removed.',
    reason:
      'The conversation is not only yours to delete. Your side of it goes; what the other person wrote stays theirs.',
  },
]

export interface AccountPurgeResult {
  /** FALSE when this account had already been deleted. Not an error. */
  firstRun: boolean
  casesDeleted: number
  participantRecordsDeleted: number
  paymentsRetained: number
}

/**
 * The two operations deletion needs, named rather than passed as a database
 * client, so the sequencing below can be tested without a database and so the
 * only user id either operation can receive is the one it is given here.
 */
export interface AccountDeletionGateway {
  purge(userId: string): Promise<AccountPurgeResult>
  deleteAuthUser(userId: string): Promise<void>
}

export type DeletionDecision =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 400 | 422; error: string }

/**
 * Decides whether to proceed, and for whom.
 *
 * `sessionUserId` is the ONLY input that can name the account. The request body
 * is read for one thing — the confirmation phrase — and anything else in it,
 * including a `userId`, is ignored rather than validated, because there is no
 * form in which it could be legitimate.
 *
 * The phrase is matched case-insensitively with surrounding and repeated
 * whitespace collapsed. The point of typing it is deliberateness, not accuracy;
 * rejecting "delete my data" because it is lowercase would only teach people to
 * paste it.
 */
export function decideDeletion(sessionUserId: string | null | undefined, body: unknown): DeletionDecision {
  if (!sessionUserId) {
    return { ok: false, status: 401, error: 'Unauthorized.' }
  }

  if (typeof body !== 'object' || body === null) {
    return { ok: false, status: 400, error: 'Invalid request body.' }
  }

  const phrase = (body as { confirmPhrase?: unknown }).confirmPhrase

  if (typeof phrase !== 'string' || normalisePhrase(phrase) !== normalisePhrase(DELETION_CONFIRMATION_PHRASE)) {
    return {
      ok: false,
      status: 422,
      error: `Type “${DELETION_CONFIRMATION_PHRASE}” to confirm. Nothing has been deleted.`,
    }
  }

  return { ok: true, userId: sessionUserId }
}

function normalisePhrase(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase()
}

export interface AccountDeletionOutcome extends AccountPurgeResult {
  /** TRUE when there was nothing left to delete, which is still a success. */
  alreadyDeleted: boolean
}

/**
 * Purges the account's data, then deletes the login.
 *
 * The order is not interchangeable. cases.user_id and participants.user_id
 * cascade from auth.users (migration 020), so deleting the login first would
 * destroy the very rows the purge uses to find the audit events and the
 * denormalised contact details it has to clean up by hand — and those would
 * survive, permanently, with nothing left to link them to anyone.
 *
 * If deleting the login fails, the data is already gone and the error propagates:
 * the user keeps a working sign-in to an empty account and can try again, which
 * is the recoverable direction. Reporting success here instead would leave them
 * able to sign in with no way to understand why.
 */
export async function performAccountDeletion(
  gateway: AccountDeletionGateway,
  userId: string
): Promise<AccountDeletionOutcome> {
  const purge = await gateway.purge(userId)
  await gateway.deleteAuthUser(userId)

  return { ...purge, alreadyDeleted: !purge.firstRun }
}

/**
 * The real gateway: the service-role client, which is the only credential that
 * may call delete_user_account() (the migration revokes it from anon and
 * authenticated) or the auth admin API.
 */
export function supabaseAccountDeletionGateway(): AccountDeletionGateway {
  const db = getServiceClient()

  return {
    async purge(userId) {
      const { data, error } = await db.rpc('delete_user_account', { p_user_id: userId })
      if (error) throw new Error(`delete_user_account failed: ${error.message}`)

      // Shaped here rather than trusted: a partially-shaped response would
      // otherwise be reported to the user as a successful deletion of zero
      // things.
      const row = (data ?? {}) as Record<string, unknown>
      return {
        firstRun: row['first_run'] === true,
        casesDeleted: Number(row['cases_deleted'] ?? 0),
        participantRecordsDeleted: Number(row['participant_records_deleted'] ?? 0),
        paymentsRetained: Number(row['payments_retained'] ?? 0),
      }
    },

    async deleteAuthUser(userId) {
      // Hard delete, explicitly. A soft delete leaves the row — and the email
      // address — in auth.users, which is the one thing this whole path exists
      // to remove.
      const { error } = await db.auth.admin.deleteUser(userId, false)

      // Already gone: the purge is idempotent and so is this, so a retry after a
      // half-finished earlier attempt must not fail on the step that succeeded.
      if (error && error.status !== 404) {
        throw new Error(`auth.admin.deleteUser failed: ${error.message}`)
      }
    },
  }
}
