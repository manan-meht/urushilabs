import { describe, it, expect } from 'vitest'
import {
  DELETION_CONFIRMATION_PHRASE,
  decideDeletion,
  performAccountDeletion,
  type AccountDeletionGateway,
  type AccountPurgeResult,
} from './deletion'

/**
 * A stand-in for delete_user_account() plus the auth admin API, modelling the
 * one property that matters: it acts on the user id it is handed, and a second
 * call finds nothing left to do.
 */
function fakeGateway(accounts: Record<string, { cases: number; payments: number }>) {
  const purged: string[] = []
  const authDeleted: string[] = []
  const calls: string[] = []

  const gateway: AccountDeletionGateway = {
    async purge(userId): Promise<AccountPurgeResult> {
      calls.push('purge')
      const account = accounts[userId]
      const firstRun = !purged.includes(userId)
      purged.push(userId)
      if (!account || !firstRun) {
        return { firstRun: false, casesDeleted: 0, participantRecordsDeleted: 0, paymentsRetained: 0 }
      }
      return {
        firstRun: true,
        casesDeleted: account.cases,
        participantRecordsDeleted: 0,
        paymentsRetained: account.payments,
      }
    },
    async deleteAuthUser(userId) {
      calls.push('deleteAuthUser')
      authDeleted.push(userId)
    },
  }

  return { gateway, purged, authDeleted, calls }
}

describe('decideDeletion', () => {
  it('refuses an unauthenticated caller', () => {
    const decision = decideDeletion(null, { confirmPhrase: DELETION_CONFIRMATION_PHRASE })
    expect(decision).toEqual({ ok: false, status: 401, error: 'Unauthorized.' })
  })

  it('never takes the account to delete from the request body', () => {
    // The failure this guards against is the whole reason this function exists:
    // an endpoint that trusts a body parameter lets any signed-in user delete
    // anyone else's recorded conversations by pasting their UUID.
    const decision = decideDeletion('session-user', {
      confirmPhrase: DELETION_CONFIRMATION_PHRASE,
      userId: 'someone-else',
      user_id: 'someone-else',
      id: 'someone-else',
    })
    expect(decision).toEqual({ ok: true, userId: 'session-user' })
  })

  it('refuses a request with no confirmation phrase', () => {
    // A mis-click, a prefetch or a CSRF'd POST must not be able to destroy
    // encrypted private disclosures that have no backup and no export.
    for (const body of [{}, null, 'DELETE MY DATA', { confirmPhrase: '' }, { confirmPhrase: true }]) {
      const decision = decideDeletion('session-user', body)
      expect(decision.ok).toBe(false)
    }
  })

  it('refuses a phrase that is merely similar', () => {
    for (const phrase of ['delete', 'DELETE MY DATA PLEASE', 'delete my dat', 'MY DATA']) {
      expect(decideDeletion('session-user', { confirmPhrase: phrase }).ok).toBe(false)
    }
  })

  it('accepts the phrase regardless of case and stray whitespace', () => {
    // Typing it is meant to prove deliberateness. Rejecting it for capitalisation
    // teaches people to copy and paste, which proves nothing.
    for (const phrase of ['DELETE MY DATA', 'delete my data', '  Delete My Data  ', 'delete  my   data']) {
      expect(decideDeletion('session-user', { confirmPhrase: phrase })).toEqual({
        ok: true,
        userId: 'session-user',
      })
    }
  })

  it('names the phrase in the rejection, and says nothing was deleted', () => {
    const decision = decideDeletion('session-user', { confirmPhrase: 'nope' })
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.error).toContain(DELETION_CONFIRMATION_PHRASE)
    expect(decision.error).toContain('Nothing has been deleted')
  })
})

describe('performAccountDeletion', () => {
  it('purges the data before deleting the login', async () => {
    // Reversed, the cascade from auth.users removes the rows the purge needs to
    // find the audit events and denormalised contact details it must clean up by
    // hand — so those survive permanently, with nothing left to link them to a
    // person or to delete them by.
    const { gateway, calls } = fakeGateway({ u1: { cases: 3, payments: 2 } })
    await performAccountDeletion(gateway, 'u1')
    expect(calls).toEqual(['purge', 'deleteAuthUser'])
  })

  it('touches only the account it was given', async () => {
    const { gateway, purged, authDeleted } = fakeGateway({
      u1: { cases: 3, payments: 2 },
      u2: { cases: 5, payments: 1 },
    })
    await performAccountDeletion(gateway, 'u1')
    expect(purged).toEqual(['u1'])
    expect(authDeleted).toEqual(['u1'])
  })

  it('is safe to call twice', async () => {
    // Real cause: the login deletion is a second step that can fail after the
    // purge succeeded, and the user is told to retry. A retry must report success
    // rather than error, and must not double-count or re-report deletions.
    const { gateway } = fakeGateway({ u1: { cases: 3, payments: 2 } })

    const first = await performAccountDeletion(gateway, 'u1')
    expect(first.alreadyDeleted).toBe(false)
    expect(first.casesDeleted).toBe(3)
    expect(first.paymentsRetained).toBe(2)

    const second = await performAccountDeletion(gateway, 'u1')
    expect(second.alreadyDeleted).toBe(true)
    expect(second.casesDeleted).toBe(0)
  })

  it('reports an account that never existed as already deleted rather than failing', async () => {
    const { gateway } = fakeGateway({})
    const outcome = await performAccountDeletion(gateway, 'ghost')
    expect(outcome.alreadyDeleted).toBe(true)
  })

  it('propagates a failure to delete the login instead of claiming success', async () => {
    // The user must not be told their account is gone while they can still sign
    // in to it — they would have no way to understand what happened, and no
    // reason to retry.
    const { gateway } = fakeGateway({ u1: { cases: 1, payments: 0 } })
    const failing: AccountDeletionGateway = {
      purge: gateway.purge,
      deleteAuthUser: async () => {
        throw new Error('auth admin unavailable')
      },
    }
    await expect(performAccountDeletion(failing, 'u1')).rejects.toThrow('auth admin unavailable')
  })
})
