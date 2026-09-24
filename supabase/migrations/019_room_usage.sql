-- ─── Recording what a mediation actually costs ─────────────────────────────
-- Until now this was unanswerable. meeting_usage had exactly the right columns
-- and every row was zeros; cases.openai_input_tokens was read by code and does
-- not exist in the database; room mode recorded nothing at all. Asked whether
-- the ₹199 / US$3 price is profitable, the only honest answer was an estimate
-- built from prompt sizes and call counts.
--
-- Mirrors meeting_usage's shape deliberately, so the two modes can be compared
-- and eventually reported together.

CREATE TABLE IF NOT EXISTS room_usage (
  session_id              UUID PRIMARY KEY REFERENCES room_sessions (id) ON DELETE CASCADE,
  case_id                 UUID NOT NULL REFERENCES cases (id) ON DELETE CASCADE,

  -- How much work the session actually was, which is what makes a cost
  -- interpretable: 150 controller calls and 9 are both "one room credit".
  intervene_calls         INTEGER NOT NULL DEFAULT 0,
  spoken_interventions    INTEGER NOT NULL DEFAULT 0,
  transcript_segments     INTEGER NOT NULL DEFAULT 0,

  -- The controller (text). Cached input is tracked separately because the
  -- system prompt is identical across a session, so the cache-hit rate is the
  -- difference between a cheap session and a dear one — and it is invisible
  -- unless recorded.
  controller_model        TEXT,
  openai_input_tokens     BIGINT NOT NULL DEFAULT 0,
  openai_cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  openai_output_tokens    BIGINT NOT NULL DEFAULT 0,

  -- Audio, billed separately and at very different rates.
  generated_audio_seconds NUMERIC NOT NULL DEFAULT 0,

  -- Computed from the token counts above at the rates in
  -- src/lib/billing/modelCosts.ts. Stored rather than derived on read so that a
  -- later price change does not silently rewrite history.
  estimated_cost_usd      NUMERIC NOT NULL DEFAULT 0,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE room_usage ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_room_usage_case ON room_usage (case_id);

-- ─── Accumulator ───────────────────────────────────────────────────────────
-- Called once per controller call, so it must be cheap and must never fail the
-- mediation. An upsert rather than an insert-then-update: the first call for a
-- session creates the row.
--
-- Costs are passed in already computed rather than calculated here, so the
-- rates live in one place in the application rather than being duplicated in
-- SQL where they would drift.

CREATE OR REPLACE FUNCTION record_room_usage(
  p_session_id UUID,
  p_case_id UUID,
  p_model TEXT,
  p_input_tokens BIGINT,
  p_cached_input_tokens BIGINT,
  p_output_tokens BIGINT,
  p_cost_usd NUMERIC,
  p_spoke BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO room_usage (
    session_id, case_id, controller_model,
    intervene_calls, spoken_interventions,
    openai_input_tokens, openai_cached_input_tokens, openai_output_tokens,
    estimated_cost_usd
  )
  VALUES (
    p_session_id, p_case_id, p_model,
    1, CASE WHEN p_spoke THEN 1 ELSE 0 END,
    GREATEST(p_input_tokens, 0), GREATEST(p_cached_input_tokens, 0), GREATEST(p_output_tokens, 0),
    GREATEST(p_cost_usd, 0)
  )
  ON CONFLICT (session_id) DO UPDATE SET
    controller_model           = COALESCE(EXCLUDED.controller_model, room_usage.controller_model),
    intervene_calls            = room_usage.intervene_calls + 1,
    spoken_interventions       = room_usage.spoken_interventions + CASE WHEN p_spoke THEN 1 ELSE 0 END,
    openai_input_tokens        = room_usage.openai_input_tokens + GREATEST(p_input_tokens, 0),
    openai_cached_input_tokens = room_usage.openai_cached_input_tokens + GREATEST(p_cached_input_tokens, 0),
    openai_output_tokens       = room_usage.openai_output_tokens + GREATEST(p_output_tokens, 0),
    estimated_cost_usd         = room_usage.estimated_cost_usd + GREATEST(p_cost_usd, 0),
    updated_at                 = NOW();
END;
$$;

COMMENT ON TABLE room_usage IS
  'Per-session cost and volume for Room Mode. estimated_cost_usd is the controller (text) cost only; realtime audio is billed separately and is not yet captured here.';
