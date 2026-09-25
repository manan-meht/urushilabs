import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { clearSession } from '@/lib/auth/session'
import {
  decideDeletion,
  performAccountDeletion,
  supabaseAccountDeletionGateway,
} from '@/lib/account/deletion'

/**
 * Deletes the caller's account and everything it holds (PDPA withdrawal of
 * consent). There is no soft-delete and no undo.
 *
 * Two properties this route exists to guarantee, both enforced in
 * decideDeletion rather than here so they can be tested without a request:
 *
 *  * It deletes the CALLER. The account is taken from the authenticated Supabase
 *    session and from nowhere else. The body is never a source of identity —
 *    there is no `userId` parameter to leave unvalidated later.
 *
 *  * It requires the confirmation phrase to be typed. A CSRF'd or
 *    mis-clicked POST cannot destroy someone's recorded arguments.
 *
 * POST rather than DELETE because it carries a body, and because a DELETE on a
 * bare resource path is exactly the shape a prefetcher or a link scanner might
 * decide to try.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // An unparseable body is a failed confirmation, not a server error — fall
  // through to decideDeletion so the caller gets the same "nothing has been
  // deleted" answer either way.
  let body: unknown = null
  try {
    body = await req.json()
  } catch {
    body = null
  }

  const decision = decideDeletion(user?.id, body)
  if (!decision.ok) {
    return NextResponse.json({ error: decision.error }, { status: decision.status })
  }

  let outcome
  try {
    outcome = await performAccountDeletion(supabaseAccountDeletionGateway(), decision.userId)
  } catch (err) {
    // Deliberately vague to the caller and specific in the logs: the user cannot
    // act on a database error, and this is the one failure where they must not be
    // told their data is gone when it might not be.
    console.error('[account/delete] deletion failed:', err)
    return NextResponse.json(
      { error: 'We could not complete the deletion. Nothing has been confirmed as deleted — please try again or contact support.' },
      { status: 500 }
    )
  }

  // Local scope only: the account is already gone, so a server-side token
  // revocation would fail against a user that no longer exists. What is still
  // needed is clearing this browser's cookies, which is the local part.
  await supabase.auth.signOut({ scope: 'local' })

  // The participant cookie is a separate, signed JWT naming a participants row
  // that has just been deleted. Left in place the browser keeps presenting it to
  // the invited-mode pages.
  await clearSession()

  return NextResponse.json({
    deleted: true,
    alreadyDeleted: outcome.alreadyDeleted,
    casesDeleted: outcome.casesDeleted,
    participantRecordsDeleted: outcome.participantRecordsDeleted,
    paymentsRetained: outcome.paymentsRetained,
  })
}
