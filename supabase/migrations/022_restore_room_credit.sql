-- ─── Giving a credit back ──────────────────────────────────────────────────
-- Credits could only ever be spent. consume_room_credit decrements
-- rooms_available and increments total_rooms_created at the moment a session is
-- created, and nothing reversed it — so any failure after that point cost the
-- customer a conversation they never had.
--
-- That is not hypothetical. Every AI call outside one code path was returning
-- HTTP 400 for about an hour after a model switch, so anyone who started an
-- invited or Together conversation in that window spent their free room on
-- something that could not reply to them. There was no way to give it back
-- short of editing the row by hand.
--
-- Deliberately the exact inverse of consume_room_credit, including
-- total_rooms_created: that column is the denominator for "conversations
-- started", and a session that failed to be created did not start one.
--
-- Returns FALSE rather than raising when there is no credits row, so a
-- compensating call on an error path cannot itself throw and mask the original
-- failure.

CREATE OR REPLACE FUNCTION restore_room_credit(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  updated INTEGER;
BEGIN
  UPDATE user_credits
  SET rooms_available     = rooms_available + 1,
      -- GREATEST guards the CHECK (total_rooms_created >= 0) constraint against
      -- a double restore, which is far better than a failed refund raising.
      total_rooms_created = GREATEST(total_rooms_created - 1, 0),
      updated_at          = NOW()
  WHERE user_id = p_user_id;

  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION restore_room_credit(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION restore_room_credit(UUID) FROM anon, authenticated;

COMMENT ON FUNCTION restore_room_credit IS
  'Inverse of consume_room_credit, for compensating a session that was charged for but could not be created. Returns FALSE when no credits row exists rather than raising, so it cannot mask the error it is compensating for.';
