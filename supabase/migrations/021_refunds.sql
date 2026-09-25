-- ─── Refunds, disputes, and taking credits back ────────────────────────────
-- Credits have only ever moved one way. 018 added add_user_credits, 002 added
-- consume_room_credit, and nothing reverses either. So a disputed card payment,
-- a duplicate charge, or a customer who simply asks for their money back all
-- end the same way: Stripe returns the money and the account keeps the pack.
-- Stripe already sends charge.refunded and charge.dispute.created; until now
-- the webhook answered 200 and did nothing with them.
--
-- ─── Why payments.status is NOT extended with 'refunded' ────────────────────
-- The obvious move is to add 'refunded' to the status CHECK and set it. That
-- would re-grant the credits. add_user_credits decides "have we already
-- credited this payment?" purely from `status = 'completed'`, so a refunded row
-- whose status is no longer 'completed' looks uncredited, and Stripe redelivers
-- checkout.session.completed for weeks after the fact — a redelivery, a support
-- replay, or the return page being reloaded would then credit the pack a second
-- time, after the refund. 'completed' here means "this payment was settled
-- once", which stays true forever, so refund state goes in columns and rows of
-- its own and the settlement flag is left alone.
--
-- ─── Why a refund does not push a balance negative ─────────────────────────
-- user_credits already forbids it (CHECK rooms_available >= 0), and that CHECK
-- is right rather than in the way. Credits are spent on mediations that have
-- already happened and already cost real money in model and audio usage; there
-- is nothing to claw back from a conversation two people have already had. A
-- negative balance would also silently eat the NEXT purchase, so the customer
-- who was refunded ₹199 pays ₹199 again later and receives nothing — which is
-- the same failure this migration exists to fix, pointing the other way.
--
-- So a reversal takes back what is still unspent, stops at zero, and records
-- the difference as a shortfall on the refund row with needs_review set. The
-- shortfall is a real loss and support should see it as one: it is the signal
-- for "this person used the service and then got their money back", which is
-- either a goodwill decision or abuse, and only a human can tell which.
--
-- ─── Why disputes do not reverse anything ──────────────────────────────────
-- A dispute is a claim, not an outcome. The money is held, not returned, and it
-- may come back to us when we win. Reversing credits at charge.dispute.created
-- would punish a customer whose card was used by someone else and who is about
-- to have the dispute resolved in their favour, and there is no re-grant path
-- to undo it with. Disputes are therefore recorded and flagged for review, and
-- the outcome (charge.dispute.closed) is not handled yet — so a lost dispute
-- leaves the credits in place until a human works the flagged row.

-- ─── Refund state on the payment itself ────────────────────────────────────
-- Additive and nullable, so nothing that reads `payments` today changes
-- behaviour. These exist so support can answer "was this refunded?" from the
-- payment row without joining, which is how the question is actually asked.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS amount_refunded_minor INTEGER NOT NULL DEFAULT 0
    CHECK (amount_refunded_minor >= 0),
  ADD COLUMN IF NOT EXISTS dispute_status TEXT
    CHECK (dispute_status IS NULL OR dispute_status IN
      ('warning_needs_response', 'needs_response', 'under_review', 'won', 'lost'));

COMMENT ON COLUMN payments.amount_refunded_minor IS
  'Minor units of payments.currency refunded so far, summed across partial refunds. Compare against amount_paise to tell a partial refund from a full one.';

COMMENT ON COLUMN payments.dispute_status IS
  'Stripe dispute status when this charge has been disputed. Set, and never used to gate crediting: a dispute is a claim, not an outcome.';

-- ─── The refund ledger ─────────────────────────────────────────────────────
-- One row per provider refund or dispute, keeping what was asked for alongside
-- what actually happened, because those differ whenever the credits were
-- already spent and the gap is the whole point of the record.

CREATE TABLE IF NOT EXISTS payment_refunds (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id           UUID NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,

  kind                 TEXT NOT NULL CHECK (kind IN ('refund', 'dispute')),
  provider             TEXT NOT NULL CHECK (provider IN ('stripe', 'razorpay')),

  -- The gateway's own id for the refund or the dispute. This is the idempotency
  -- key: see the unique index below.
  provider_refund_id   TEXT NOT NULL,

  amount_minor         INTEGER NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  currency             TEXT,
  reason               TEXT,

  -- What this refund should have taken back: the product's grant scaled by how
  -- much of the charge is refunded, less whatever an earlier partial refund on
  -- the same payment already took.
  rooms_requested      INTEGER NOT NULL DEFAULT 0 CHECK (rooms_requested >= 0),
  follow_ups_requested INTEGER NOT NULL DEFAULT 0 CHECK (follow_ups_requested >= 0),

  -- What was actually unspent and could be taken.
  rooms_reversed       INTEGER NOT NULL DEFAULT 0 CHECK (rooms_reversed >= 0),
  follow_ups_reversed  INTEGER NOT NULL DEFAULT 0 CHECK (follow_ups_reversed >= 0),

  -- Credits the customer had already spent and keeps. Money out with the
  -- service already delivered — the number support needs to see.
  rooms_shortfall      INTEGER NOT NULL DEFAULT 0 CHECK (rooms_shortfall >= 0),
  follow_ups_shortfall INTEGER NOT NULL DEFAULT 0 CHECK (follow_ups_shortfall >= 0),

  needs_review         BOOLEAN NOT NULL DEFAULT FALSE,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE payment_refunds ENABLE ROW LEVEL SECURITY;

-- No SELECT policy, matching `payments`: refund rows are support's view of an
-- account, and reach the application only through the service role.

-- The idempotency key. Stripe redelivers an event until it gets a 2xx and
-- resends old events during an endpoint replay, so "have we already reversed
-- this refund?" has to be a constraint rather than a check the route performs
-- and then races itself on.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_refunds_provider_ref
  ON payment_refunds (provider, provider_refund_id);

CREATE INDEX IF NOT EXISTS idx_payment_refunds_payment ON payment_refunds (payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_refunds_user ON payment_refunds (user_id, created_at DESC);

-- Support's queue, and small: most refunds reverse cleanly and never appear.
CREATE INDEX IF NOT EXISTS idx_payment_refunds_review
  ON payment_refunds (created_at DESC) WHERE needs_review;

-- ─── The reversal ──────────────────────────────────────────────────────────
-- Records the refund and takes back what is still there, in one statement's
-- worth of locking, for the same reason add_user_credits credits inside a
-- function rather than in the route: the callers race each other, and "already
-- handled?" must be decided once under a row lock.
--
-- The clamp below is deliberately arithmetic rather than a conditional. It is
-- what keeps a reversal from failing on the CHECK constraint and returning a
-- 500 to Stripe, which would then redeliver the same refund forever.
--
-- Returns a JSONB summary rather than a boolean, because the caller has to log
-- the difference between "reversed 3 rooms" and "reversed 1, customer keeps 2"
-- and a boolean cannot say that.

CREATE OR REPLACE FUNCTION reverse_user_credits(
  p_payment_id UUID,
  p_provider TEXT,
  p_provider_refund_id TEXT,
  p_kind TEXT,
  p_rooms INTEGER,
  p_follow_ups INTEGER,
  p_amount_minor INTEGER DEFAULT 0,
  p_currency TEXT DEFAULT NULL,
  p_reason TEXT DEFAULT NULL,
  p_dispute_status TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_status TEXT;
  v_refund_id UUID;
  v_rooms_wanted INTEGER := GREATEST(COALESCE(p_rooms, 0), 0);
  v_follow_ups_wanted INTEGER := GREATEST(COALESCE(p_follow_ups, 0), 0);
  v_rooms_already INTEGER := 0;
  v_follow_ups_already INTEGER := 0;
  v_rooms_have INTEGER := 0;
  v_follow_ups_have INTEGER := 0;
  v_rooms_taken INTEGER := 0;
  v_follow_ups_taken INTEGER := 0;
  v_existing JSONB;
BEGIN
  IF p_kind NOT IN ('refund', 'dispute') THEN
    RAISE EXCEPTION 'reverse_user_credits: unknown kind %', p_kind;
  END IF;

  -- Lock the payment first, so two deliveries of the same event serialise here
  -- rather than both reading a balance and both subtracting from it.
  SELECT user_id, status INTO v_user_id, v_status FROM payments WHERE id = p_payment_id FOR UPDATE;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'reverse_user_credits: payment % does not exist', p_payment_id;
  END IF;

  -- The caller asks for what the share of the charge refunded SO FAR implies in
  -- total, not for the slice this one refund adds, because a single refund's
  -- share rarely lands on a whole credit and rounding each one separately either
  -- loses a credit or invents one. That means the second of two partial refunds
  -- asks for the whole grant again, so what earlier refunds already took is
  -- subtracted here, where the rows are: partial refunds in any order add up to
  -- the grant and never past it.
  IF p_kind = 'refund' THEN
    SELECT COALESCE(SUM(rooms_reversed), 0), COALESCE(SUM(follow_ups_reversed), 0)
    INTO v_rooms_already, v_follow_ups_already
    FROM payment_refunds WHERE payment_id = p_payment_id AND kind = 'refund';

    v_rooms_wanted := GREATEST(v_rooms_wanted - v_rooms_already, 0);
    v_follow_ups_wanted := GREATEST(v_follow_ups_wanted - v_follow_ups_already, 0);
  END IF;

  INSERT INTO payment_refunds (
    payment_id, user_id, kind, provider, provider_refund_id,
    amount_minor, currency, reason,
    rooms_requested, follow_ups_requested
  ) VALUES (
    p_payment_id, v_user_id, p_kind, p_provider, p_provider_refund_id,
    GREATEST(COALESCE(p_amount_minor, 0), 0), p_currency, p_reason,
    v_rooms_wanted, v_follow_ups_wanted
  )
  ON CONFLICT (provider, provider_refund_id) DO NOTHING
  RETURNING id INTO v_refund_id;

  -- Already recorded: a redelivery, or the same dispute arriving twice. Report
  -- what the first pass did, and touch nothing.
  IF v_refund_id IS NULL THEN
    SELECT jsonb_build_object(
      'applied', FALSE,
      'reason', 'already_recorded',
      'kind', kind,
      'rooms_reversed', rooms_reversed,
      'follow_ups_reversed', follow_ups_reversed,
      'rooms_shortfall', rooms_shortfall,
      'follow_ups_shortfall', follow_ups_shortfall,
      'needs_review', needs_review
    ) INTO v_existing
    FROM payment_refunds
    WHERE provider = p_provider AND provider_refund_id = p_provider_refund_id;

    RETURN v_existing;
  END IF;

  -- A dispute is recorded and flagged, and moves no credits. See the header.
  IF p_kind = 'dispute' THEN
    UPDATE payment_refunds SET needs_review = TRUE, updated_at = NOW() WHERE id = v_refund_id;

    UPDATE payments
    SET dispute_status = COALESCE(p_dispute_status, dispute_status, 'needs_response'),
        updated_at = NOW()
    WHERE id = p_payment_id;

    RETURN jsonb_build_object(
      'applied', TRUE,
      'reason', 'dispute_recorded',
      'kind', 'dispute',
      'rooms_reversed', 0,
      'follow_ups_reversed', 0,
      'rooms_shortfall', 0,
      'follow_ups_shortfall', 0,
      'needs_review', TRUE
    );
  END IF;

  -- ─── The refund that overtook its own payment ─────────────────────────────
  -- Event order is not guaranteed, and a redelivery can arrive in any order at
  -- all, so charge.refunded can reach us before the checkout event that grants
  -- the credits. Reversing here would take credits from some OTHER purchase,
  -- since a balance does not remember which payment filled it; doing nothing
  -- would leave the later crediting event free to grant a pack that has already
  -- been refunded.
  --
  -- A pending payment is therefore settled as part of recording the refund.
  -- add_user_credits keys on status = 'completed' and so returns FALSE when the
  -- credit event finally arrives, which is exactly the outcome wanted: no
  -- credits granted, nothing taken from anyone else, and a flagged row, because
  -- a customer who is owed a pack and has also been refunded needs a human.
  IF v_status <> 'completed' THEN
    IF v_status = 'pending' THEN
      UPDATE payments SET status = 'completed', updated_at = NOW() WHERE id = p_payment_id;
    END IF;

    UPDATE payment_refunds
    SET rooms_requested = 0, follow_ups_requested = 0, needs_review = TRUE, updated_at = NOW()
    WHERE id = v_refund_id;

    UPDATE payments
    SET refunded_at = COALESCE(refunded_at, NOW()),
        amount_refunded_minor = amount_refunded_minor + GREATEST(COALESCE(p_amount_minor, 0), 0),
        updated_at = NOW()
    WHERE id = p_payment_id;

    RETURN jsonb_build_object(
      'applied', TRUE,
      'reason', 'blocked_uncredited',
      'kind', 'refund',
      'rooms_reversed', 0,
      'follow_ups_reversed', 0,
      'rooms_shortfall', 0,
      'follow_ups_shortfall', 0,
      'needs_review', TRUE
    );
  END IF;

  -- A user with no credits row has nothing to take; the balance stays zero
  -- rather than a row being created in order to be debited.
  SELECT rooms_available, follow_ups_available
  INTO v_rooms_have, v_follow_ups_have
  FROM user_credits WHERE user_id = v_user_id FOR UPDATE;

  v_rooms_taken := LEAST(v_rooms_wanted, COALESCE(v_rooms_have, 0));
  v_follow_ups_taken := LEAST(v_follow_ups_wanted, COALESCE(v_follow_ups_have, 0));

  IF v_rooms_taken > 0 OR v_follow_ups_taken > 0 THEN
    UPDATE user_credits
    SET rooms_available      = rooms_available - v_rooms_taken,
        follow_ups_available = follow_ups_available - v_follow_ups_taken,
        updated_at           = NOW()
    WHERE user_id = v_user_id;
  END IF;

  -- total_rooms_created is deliberately not decremented: it counts mediations
  -- that happened, and a refund does not un-happen them.

  UPDATE payment_refunds
  SET rooms_reversed       = v_rooms_taken,
      follow_ups_reversed  = v_follow_ups_taken,
      rooms_shortfall      = v_rooms_wanted - v_rooms_taken,
      follow_ups_shortfall = v_follow_ups_wanted - v_follow_ups_taken,
      needs_review         = (v_rooms_wanted - v_rooms_taken) > 0
                             OR (v_follow_ups_wanted - v_follow_ups_taken) > 0,
      updated_at           = NOW()
  WHERE id = v_refund_id;

  UPDATE payments
  SET refunded_at = COALESCE(refunded_at, NOW()),
      amount_refunded_minor = amount_refunded_minor + GREATEST(COALESCE(p_amount_minor, 0), 0),
      updated_at = NOW()
  WHERE id = p_payment_id;

  RETURN jsonb_build_object(
    'applied', TRUE,
    'reason', 'reversed',
    'kind', 'refund',
    'rooms_reversed', v_rooms_taken,
    'follow_ups_reversed', v_follow_ups_taken,
    'rooms_shortfall', v_rooms_wanted - v_rooms_taken,
    'follow_ups_shortfall', v_follow_ups_wanted - v_follow_ups_taken,
    'needs_review', (v_rooms_wanted - v_rooms_taken) > 0
                    OR (v_follow_ups_wanted - v_follow_ups_taken) > 0
  );
END;
$$;

COMMENT ON FUNCTION reverse_user_credits IS
  'Records a refund or dispute once per provider refund id and takes back unspent credits, stopping at zero. applied=false means the refund was already recorded, which is the normal outcome of a Stripe redelivery. A shortfall means the customer had already spent the credits and keeps them; needs_review is set so support sees it.';

COMMENT ON TABLE payment_refunds IS
  'One row per gateway refund or dispute. rooms_requested minus rooms_reversed is the shortfall: credits already spent that could not be taken back, which is a real loss rather than an error.';
