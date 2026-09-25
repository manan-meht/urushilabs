-- ─── Account deletion (PDPA withdrawal of consent) ──────────────────────────
-- Tistra Pte Ltd is a Singapore entity, so the PDPA's withdrawal-of-consent and
-- deletion obligations apply to everything this product stores — and what it
-- stores is recorded arguments, voice transcripts and AES-256-GCM encrypted
-- private disclosures about people's conflicts. Until now there was no way for a
-- user to delete any of it, by any route.
--
-- Most of the work is already done by ON DELETE CASCADE from `cases`: deleting a
-- case takes its participants, intake_messages, submissions, analyses,
-- agreements, notification_logs, conversation_settings_acceptances, and the whole
-- together_*, room_* and meeting_* subtrees with it. This migration does NOT
-- re-delete any of that. It exists for the four places where the cascades do the
-- wrong thing, plus one genuine judgement call about `payments`.
--
-- The four gaps, each a real way data survives a deletion:
--
--  1. cases.user_id and participants.user_id are ON DELETE SET NULL (004). So
--     deleting the auth.users row — which is what the Supabase dashboard's
--     "delete user" button does — does not delete the conflict data. It
--     DETACHES it: every transcript and encrypted disclosure stays in the
--     database forever with user_id NULL, and with nothing left to link it back
--     to the person who asked for it to go. That is the worst of both outcomes,
--     and it is the current behaviour.
--
--  2. audit_events.case_id and .participant_id are also ON DELETE SET NULL, and
--     audit_events carries ip_address. An IP address is personal data. Deleting
--     someone's cases therefore leaves their IP addresses behind in orphaned
--     rows. No foreign key can fix this; the rows have to be deleted explicitly.
--
--  3. `cases` denormalises contact details into initiator_name/email/phone and
--     recipient_name/email/phone. When a user was the OTHER party in someone
--     else's case, deleting their `participants` row leaves their name, email
--     and phone number sitting in those columns on a case we must not delete.
--
--  4. payments.user_id is NOT NULL and ON DELETE CASCADE, so today deleting an
--     account destroys its financial records. See the retention note below.
--
-- Ordering matters and is enforced by the application: purge through
-- delete_user_account() FIRST, then delete the auth.users row. The reverse order
-- triggers gap 1 and the data becomes unreachable and undeletable.

BEGIN;

-- ─── Retention decision: payments are kept, and anonymised ──────────────────
-- DECISION: payment rows are retained with user_id set to NULL. They are not
-- deleted.
--
-- Reasoning, because this is a legal judgement and not a technical one:
--
--  * Section 67 of Singapore's Income Tax Act requires business records to be
--    kept for five years from the end of the relevant year of assessment, and
--    Tistra is GST-registered (see the automatic_tax note in
--    src/lib/billing/providers/stripe.ts), which carries the same five-year
--    record-keeping duty. A customer's deletion request does not discharge a
--    statutory retention obligation, and the PDPA does not require it to — it
--    permits retention where another law requires it.
--
--  * The PDPA's actual requirement is that personal data stop being retained
--    once it no longer serves a legal or business purpose. What the tax
--    obligation needs is the transaction: amount, currency, market, gateway,
--    gateway reference, timestamps. It does not need to be linked to an
--    identified person. So we keep the transaction and drop the link.
--
--  * user_id is the only identifying column on `payments`. Once it is NULL and
--    auth.users is gone, the row cannot be re-identified from anything in this
--    database. If Tistra is ever lawfully compelled to identify a specific
--    transaction's payer, provider_payment_id resolves it at Stripe or
--    Razorpay, who are separately obliged to hold payer identity as the
--    processor of record. That is deliberately a higher bar than a SQL query.
--
--  * Rejected alternative: keeping a stable pseudonymous key on the row so that
--    several payments by the same deleted account could still be grouped. It
--    buys nothing the tax records need, and a key that is derived from (or equal
--    to) the old user id means re-identification is reasonably possible for
--    anyone holding a backup of auth.users — which makes the row still personal
--    data, and the anonymisation a pretence.
--
-- Consequence for accounting: a deleted account's payments become
-- customer-less. Revenue, GST and per-transaction reconciliation all still work;
-- "lifetime value per customer" for those rows does not. That is the intended
-- trade.

ALTER TABLE payments ALTER COLUMN user_id DROP NOT NULL;

-- Belt as well as braces. The application always NULLs user_id before the
-- auth.users row goes, but a deletion performed by hand from the Supabase
-- dashboard bypasses the application entirely — and with the FK left as
-- CASCADE that click silently destroys five years of tax records.
--
-- Found by name rather than assumed to be payments_user_id_fkey: this table was
-- created by hand in production before it was ever in a migration (see 018), so
-- its constraint name is whatever that session happened to produce. Dropping a
-- name that does not exist and then adding this one would leave TWO foreign keys
-- on the column, and the surviving CASCADE would still delete the rows —
-- a migration that reports success and changes nothing that matters.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE con.contype = 'f'
      AND nsp.nspname = 'public'
      AND rel.relname = 'payments'
      AND con.confrelid = 'auth.users'::REGCLASS
      AND con.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute
         WHERE attrelid = rel.oid AND attname = 'user_id' AND NOT attisdropped)
      ]::SMALLINT[]
  LOOP
    EXECUTE FORMAT('ALTER TABLE payments DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE payments
  ADD CONSTRAINT payments_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE SET NULL;

COMMENT ON COLUMN payments.user_id IS
  'NULL means the purchasing account was deleted. The transaction is retained for statutory record-keeping; see migration 020 for the reasoning.';

-- ─── cases/participants: cascade instead of detach ──────────────────────────
-- Same defence-in-depth argument, pointing the other way. SET NULL was chosen in
-- 004 when user_id was a new, optional convenience column; with no deletion path
-- in the product the question of what it meant for an account to go away never
-- came up. It means: keep the recorded argument, forget whose it was.
--
-- CASCADE is the safer failure for this data. A dashboard deletion now destroys
-- the conflict data instead of orphaning it permanently.
--
-- This does NOT make delete_user_account() redundant, and the application must
-- still go through it: a foreign key cannot delete the audit_events IP addresses
-- (gap 2), cannot scrub the denormalised contact columns (gap 3), and cannot
-- record that the deletion happened.

ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_user_id_fkey;
ALTER TABLE cases
  ADD CONSTRAINT cases_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;

ALTER TABLE participants DROP CONSTRAINT IF EXISTS participants_user_id_fkey;
ALTER TABLE participants
  ADD CONSTRAINT participants_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;

-- ─── Evidence that a deletion was honoured ──────────────────────────────────
-- PDPA compliance is not only doing the deletion; it is being able to show it
-- was done, after every trace of the requester has been removed.
--
-- Holds no personal data by construction: no name, no email, no phone, no case
-- reference, no IP. The user_id is deliberately NOT a foreign key — the row it
-- would point at is gone by the time anyone reads this, which is the whole
-- point, and once auth.users no longer has it the UUID identifies nothing.

CREATE TABLE IF NOT EXISTS account_deletions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Unique so a retry cannot fabricate a second deletion event for one account.
  user_id                     UUID NOT NULL UNIQUE,
  deleted_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cases_deleted               INTEGER NOT NULL DEFAULT 0,
  participant_records_deleted INTEGER NOT NULL DEFAULT 0,
  payments_retained           INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE account_deletions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE account_deletions IS
  'One row per honoured deletion request. Contains no personal data and no foreign keys by design; see migration 020.';

-- ─── delete_user_account ────────────────────────────────────────────────────
-- Everything a user owns, in one transaction, safe to call twice.
--
-- In SQL rather than in the route because it must be all-or-nothing. Driven from
-- TypeScript this would be eleven separate statements over supabase-js with no
-- shared transaction, and the failure mode is an account that is half deleted:
-- cases gone, payments still attached, no record of what happened, and a user
-- who has been told their data is gone looking at a dashboard that still works.
--
-- Idempotent because every statement is a DELETE or UPDATE by predicate, so a
-- second call matches nothing, and the tombstone insert is ON CONFLICT DO
-- NOTHING. This matters in practice: the route deletes the auth.users row after
-- this returns, and if that second step fails the user is expected to retry.
--
-- A case owned by the requester is deleted WHOLE, including the other party's
-- submissions. A mediation case is jointly held, but every artefact in it — the
-- analysis, the shared understanding, the agreements, the final report — is
-- derived from both parties' private disclosures and cannot be separated from
-- them. Retaining a case stripped of the requester's half would leave something
-- that still describes their conflict, still names them in the other party's
-- copy, and is useless to the person it was left for. The UI says plainly that
-- the other person loses access.

CREATE OR REPLACE FUNCTION delete_user_account(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
-- Pinned because this function runs as its owner and deletes by unqualified
-- table name. Without it, a caller who can set search_path chooses which tables
-- those names resolve to.
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owned_case_ids       UUID[];
  v_participant_ids      UUID[];
  v_cases_deleted        INTEGER := 0;
  v_participants_deleted INTEGER := 0;
  v_payments_retained    INTEGER := 0;
  v_tombstone_written    INTEGER := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'delete_user_account: p_user_id is required';
  END IF;

  -- Cases the user owns. Collected up front because the cascades below remove
  -- the rows this set is derived from.
  SELECT COALESCE(ARRAY_AGG(id), '{}'::UUID[]) INTO v_owned_case_ids
  FROM cases WHERE user_id = p_user_id;

  -- Cases the user took part in but does not own — they were invited into
  -- someone else's conversation. Their participant row goes; the case stays.
  SELECT COALESCE(ARRAY_AGG(id), '{}'::UUID[]) INTO v_participant_ids
  FROM participants
  WHERE user_id = p_user_id
    AND NOT (case_id = ANY (v_owned_case_ids));

  -- Gap 2: audit_events survives its case and its participant (both SET NULL)
  -- and carries ip_address, so these rows have to go explicitly and BEFORE the
  -- deletes that would sever the link and make them unfindable.
  DELETE FROM audit_events
  WHERE case_id = ANY (v_owned_case_ids)
     OR participant_id = ANY (v_participant_ids);

  -- Gap 3: the requester's name, email and phone are also denormalised onto the
  -- other party's `cases` row. recipient_name/initiator_name are NOT NULL, so
  -- they are replaced rather than cleared — the other party still needs their
  -- own case to render.
  UPDATE cases c
  SET recipient_name  = 'Deleted account',
      recipient_email = NULL,
      recipient_phone = NULL
  FROM participants p
  WHERE p.id = ANY (v_participant_ids)
    AND p.case_id = c.id
    AND p.role = 'recipient';

  UPDATE cases c
  SET initiator_name  = 'Deleted account',
      initiator_email = NULL,
      initiator_phone = NULL
  FROM participants p
  WHERE p.id = ANY (v_participant_ids)
    AND p.case_id = c.id
    AND p.role = 'initiator';

  -- conversation_settings_acceptances cascades from `cases`, not from
  -- `participants`, and keys the person by a free-text participant_ref. In a
  -- case we are keeping, the requester's acceptance rows would otherwise outlive
  -- the participant row they refer to.
  DELETE FROM conversation_settings_acceptances
  WHERE participant_ref = ANY (ARRAY(SELECT u::TEXT FROM unnest(v_participant_ids) AS u));

  DELETE FROM participants WHERE id = ANY (v_participant_ids);
  GET DIAGNOSTICS v_participants_deleted = ROW_COUNT;

  -- The cascade from `cases` does the bulk of the work here: intake_messages,
  -- submissions, analyses, agreements, notification_logs, and the together_*,
  -- room_* and meeting_* subtrees including every transcript segment.
  DELETE FROM cases WHERE id = ANY (v_owned_case_ids);
  GET DIAGNOSTICS v_cases_deleted = ROW_COUNT;

  -- Both cascade from auth.users, but the auth row is deleted after this
  -- function returns and that step can fail. Doing them here means a failed
  -- retry does not leave a live hardware pairing token behind.
  DELETE FROM room_devices WHERE user_id = p_user_id;
  DELETE FROM user_credits WHERE user_id = p_user_id;

  -- Retained and anonymised; see the retention decision above.
  UPDATE payments SET user_id = NULL, updated_at = NOW() WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_payments_retained = ROW_COUNT;

  INSERT INTO account_deletions (
    user_id, cases_deleted, participant_records_deleted, payments_retained
  )
  VALUES (
    p_user_id, v_cases_deleted, v_participants_deleted, v_payments_retained
  )
  ON CONFLICT (user_id) DO NOTHING;
  GET DIAGNOSTICS v_tombstone_written = ROW_COUNT;

  RETURN jsonb_build_object(
    -- FALSE on a second call. The caller uses this to tell "we deleted your
    -- account" from "your account was already deleted", both of which are
    -- successes.
    'first_run',                   v_tombstone_written > 0,
    'cases_deleted',               v_cases_deleted,
    'participant_records_deleted', v_participants_deleted,
    'payments_retained',           v_payments_retained
  );
END;
$$;

-- This function deletes any account by UUID and runs with its owner's rights.
-- NEXT_PUBLIC_SUPABASE_ANON_KEY is in the browser bundle and can call RPCs, so
-- leaving the default PUBLIC execute grant in place would be a way for anyone to
-- delete anyone's account with one HTTP request.
REVOKE ALL ON FUNCTION delete_user_account(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION delete_user_account(UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION delete_user_account(UUID) TO service_role;

COMMENT ON FUNCTION delete_user_account IS
  'Deletes or anonymises everything belonging to one account, in one transaction. Safe to call twice; first_run is FALSE on a repeat. Must be called BEFORE the auth.users row is deleted, or cases.user_id cascades and the data becomes unreachable. service_role only.';

COMMIT;
