-- ─── Meeting usage: make the counters atomic and record what the calls cost ──
--
-- meeting_usage had the right columns and, for every completed session, zeros in
-- the token columns and NULL duration. Two causes:
--
--   1. The recorder was a read-modify-write upsert. Recall delivers the last
--      transcript segments and meeting_ended within the same second, so the
--      completion write (tokens + duration) raced a segment increment that had
--      read the row before it and wrote the stale snapshot back over it.
--   2. Only the final report ever passed tokens at all. Stage A and Stage B of
--      every intervention, and TTS, recorded nothing.
--
-- This mirrors record_room_usage (019): every write is a single additive
-- statement under the row's own lock, so concurrent webhooks cannot lose each
-- other's updates.

ALTER TABLE meeting_usage
  ADD COLUMN IF NOT EXISTS openai_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS controller_model           TEXT,
  ADD COLUMN IF NOT EXISTS openai_cost_usd            NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tts_cost_usd               NUMERIC NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION record_meeting_usage(
  p_session_id          UUID,
  p_model               TEXT    DEFAULT NULL,
  p_input_tokens        BIGINT  DEFAULT 0,
  p_cached_input_tokens BIGINT  DEFAULT 0,
  p_output_tokens       BIGINT  DEFAULT 0,
  p_openai_cost_usd     NUMERIC DEFAULT 0,
  p_segments            INTEGER DEFAULT 0,
  p_interventions       INTEGER DEFAULT 0,
  p_audio_seconds       NUMERIC DEFAULT 0,
  p_tts_cost_usd        NUMERIC DEFAULT 0,
  p_duration_seconds    INTEGER DEFAULT NULL,
  p_provider_cost_usd   NUMERIC DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO meeting_usage (
    session_id, controller_model,
    transcript_segment_count, intervention_count,
    openai_input_tokens, openai_cached_input_tokens, openai_output_tokens,
    openai_cost_usd, generated_audio_seconds, tts_cost_usd,
    meeting_duration_seconds, provider_cost_usd, estimated_total_cost_usd
  )
  VALUES (
    p_session_id, p_model,
    GREATEST(p_segments, 0), GREATEST(p_interventions, 0),
    GREATEST(p_input_tokens, 0), GREATEST(p_cached_input_tokens, 0), GREATEST(p_output_tokens, 0),
    GREATEST(p_openai_cost_usd, 0), GREATEST(p_audio_seconds, 0), GREATEST(p_tts_cost_usd, 0),
    p_duration_seconds, p_provider_cost_usd,
    GREATEST(p_openai_cost_usd, 0) + GREATEST(p_tts_cost_usd, 0) + COALESCE(p_provider_cost_usd, 0)
  )
  ON CONFLICT (session_id) DO UPDATE SET
    controller_model           = COALESCE(EXCLUDED.controller_model, meeting_usage.controller_model),
    transcript_segment_count   = meeting_usage.transcript_segment_count   + GREATEST(p_segments, 0),
    intervention_count         = meeting_usage.intervention_count         + GREATEST(p_interventions, 0),
    openai_input_tokens        = meeting_usage.openai_input_tokens        + GREATEST(p_input_tokens, 0),
    openai_cached_input_tokens = meeting_usage.openai_cached_input_tokens + GREATEST(p_cached_input_tokens, 0),
    openai_output_tokens       = meeting_usage.openai_output_tokens       + GREATEST(p_output_tokens, 0),
    openai_cost_usd            = meeting_usage.openai_cost_usd            + GREATEST(p_openai_cost_usd, 0),
    generated_audio_seconds    = meeting_usage.generated_audio_seconds    + GREATEST(p_audio_seconds, 0),
    tts_cost_usd               = meeting_usage.tts_cost_usd               + GREATEST(p_tts_cost_usd, 0),
    meeting_duration_seconds   = COALESCE(p_duration_seconds, meeting_usage.meeting_duration_seconds),
    provider_cost_usd          = COALESCE(p_provider_cost_usd, meeting_usage.provider_cost_usd),
    estimated_total_cost_usd   =
        meeting_usage.openai_cost_usd + GREATEST(p_openai_cost_usd, 0)
      + meeting_usage.tts_cost_usd    + GREATEST(p_tts_cost_usd, 0)
      + COALESCE(p_provider_cost_usd, meeting_usage.provider_cost_usd, 0),
    updated_at                 = NOW();
END;
$$;

COMMENT ON TABLE meeting_usage IS
  'Per-session cost and volume for Meeting Mediation. openai_cost_usd covers Stage A, Stage B and the final report; tts_cost_usd is estimated from spoken length; provider_cost_usd is the meeting bot (Recall) at its hourly rate over meeting_duration_seconds; estimated_total_cost_usd is their sum.';
