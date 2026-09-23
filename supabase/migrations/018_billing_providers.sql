-- ─── Billing: two gateways, one credit ledger ──────────────────────────────
-- Three separate problems, all in this area, fixed together.
--
-- 1. `payments` and `user_credits` exist in the production database but in NO
--    migration. They were created by hand, so the repository has never been able
--    to reproduce the schema it runs against. Both are declared here with IF NOT
--    EXISTS, so this is a no-op against the live database and a correct build
--    against an empty one.
--
-- 2. `add_user_credits` does not exist at all. /api/payments/verify calls it,
--    logs the failure, and deliberately does not fail the response — so a
--    "successful" purchase marked the payment complete and granted nothing.
--    No purchase has ever added a credit. (consume_room_credit does exist and
--    has been spending them; one account shows 54 rooms created.)
--
-- 3. The payment columns are Razorpay-specific. Stripe serves every non-India
--    market, so the table needs to record WHICH gateway a payment went through.

CREATE TABLE IF NOT EXISTS user_credits (
  user_id             UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  rooms_available     INTEGER NOT NULL DEFAULT 1 CHECK (rooms_available >= 0),
  follow_ups_available INTEGER NOT NULL DEFAULT 0 CHECK (follow_ups_available >= 0),
  total_rooms_created INTEGER NOT NULL DEFAULT 0 CHECK (total_rooms_created >= 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  product_key       TEXT NOT NULL,
  amount_paise      INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'completed', 'failed')),
  razorpay_order_id   TEXT,
  razorpay_payment_id TEXT,
  razorpay_signature  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- ─── Gateway-neutral columns ───────────────────────────────────────────────
-- The razorpay_* columns stay for the rows that already use them; new writes go
-- through these. amount_paise keeps its name for the same reason — renaming a
-- column that live code reads buys nothing here — but it holds MINOR UNITS of
-- whatever currency the row is in, which for Stripe markets is cents.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS provider TEXT
    CHECK (provider IS NULL OR provider IN ('stripe', 'razorpay')),
  ADD COLUMN IF NOT EXISTS provider_order_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_payment_id TEXT,
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS market TEXT;

-- Everything that exists today predates Stripe and is therefore Razorpay's.
UPDATE payments SET provider = 'razorpay' WHERE provider IS NULL;
UPDATE payments SET provider_order_id = razorpay_order_id
  WHERE provider_order_id IS NULL AND razorpay_order_id IS NOT NULL;
UPDATE payments SET provider_payment_id = razorpay_payment_id
  WHERE provider_payment_id IS NULL AND razorpay_payment_id IS NOT NULL;

-- One completed payment per gateway reference. This is what makes crediting
-- idempotent: a webhook redelivery and the browser returning from checkout race
-- each other routinely, and both paths try to settle the same payment.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_payment
  ON payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id, created_at DESC);

-- ─── The missing function ──────────────────────────────────────────────────
-- Adds credits and is safe to call twice for the same payment.
--
-- Idempotency lives here rather than in the route because there are two callers
-- that can arrive in either order — the Stripe webhook and the browser coming
-- back from checkout — and "have we already credited this payment?" must be
-- decided in one place, under the row lock, not in application code racing
-- itself.

CREATE OR REPLACE FUNCTION add_user_credits(
  p_user_id UUID,
  p_rooms INTEGER,
  p_follow_ups INTEGER,
  p_payment_id UUID DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  already_settled BOOLEAN;
BEGIN
  -- When a payment is named, settle it exactly once. The row lock serialises
  -- the webhook against the return page.
  IF p_payment_id IS NOT NULL THEN
    SELECT (status = 'completed') INTO already_settled
    FROM payments WHERE id = p_payment_id FOR UPDATE;

    IF already_settled IS NULL THEN
      RAISE EXCEPTION 'add_user_credits: payment % does not exist', p_payment_id;
    END IF;

    IF already_settled THEN
      RETURN FALSE;  -- Already credited; not an error.
    END IF;

    UPDATE payments SET status = 'completed', updated_at = NOW() WHERE id = p_payment_id;
  END IF;

  INSERT INTO user_credits (user_id, rooms_available, follow_ups_available)
  VALUES (p_user_id, GREATEST(p_rooms, 0), GREATEST(p_follow_ups, 0))
  ON CONFLICT (user_id) DO UPDATE
    SET rooms_available      = user_credits.rooms_available + GREATEST(p_rooms, 0),
        follow_ups_available = user_credits.follow_ups_available + GREATEST(p_follow_ups, 0),
        updated_at           = NOW();

  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION add_user_credits IS
  'Grants credits, settling the named payment exactly once. Returns FALSE when the payment was already settled, which is the normal outcome of a webhook racing the checkout return page.';

COMMENT ON COLUMN payments.amount_paise IS
  'Minor units of payments.currency — paise for INR, cents for USD/SGD. Name kept for compatibility with existing code.';
