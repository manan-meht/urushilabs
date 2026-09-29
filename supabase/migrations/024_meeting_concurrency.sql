-- ─── Meeting mode under concurrency ──────────────────────────────────────────
--
-- Three things the last live session showed, once the transcript stopped
-- serialising everything behind our slow webhook responses:
--
--   1. runtime_state was written as a whole object by whoever finished last.
--      The pipeline loads it, spends 20-30 s on model calls, and writes it
--      back, erasing every speech_on/off and bot-status flip the webhook wrote
--      in between. The session had 65 speech events and 7 spoken interventions
--      and ended with an empty speakingNow and no botStatus. Writes are now
--      JSON merges of only the keys the writer owns.
--   2. Two transcript segments arriving close together each ran the full
--      decision pipeline, and Urushi made the same point three times. One
--      deliberation per session at a time; the rest store their segment and
--      let the running one see it.
--   3. sequence_number was COUNT(*)+1, so concurrent inserts collided.

ALTER TABLE meeting_sessions
  ADD COLUMN IF NOT EXISTS deliberating_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_sequence      INTEGER;

-- Seed the counter from what exists so old sessions keep numbering correctly.
UPDATE meeting_sessions s
SET next_sequence = COALESCE((
  SELECT MAX(t.sequence_number) FROM meeting_transcript_segments t WHERE t.session_id = s.id
), 0)
WHERE next_sequence IS NULL;

-- Merge a patch into runtime_state. Top-level keys in the patch replace the
-- stored ones; `speakingNow` is merged one level deeper, and a JSON null value
-- inside it removes that participant (a speech_off).
CREATE OR REPLACE FUNCTION merge_meeting_runtime_state(p_session_id UUID, p_patch JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current  JSONB;
  v_speaking JSONB;
  v_merged   JSONB;
BEGIN
  SELECT COALESCE(runtime_state, '{}'::jsonb) INTO v_current
  FROM meeting_sessions WHERE id = p_session_id FOR UPDATE;

  IF v_current IS NULL THEN
    RETURN NULL;
  END IF;

  v_merged := v_current || (p_patch - 'speakingNow');

  IF p_patch ? 'speakingNow' THEN
    v_speaking := jsonb_strip_nulls(
      COALESCE(v_current -> 'speakingNow', '{}'::jsonb) || COALESCE(p_patch -> 'speakingNow', '{}'::jsonb)
    );
    v_merged := jsonb_set(v_merged, '{speakingNow}', v_speaking, true);
  END IF;

  UPDATE meeting_sessions SET runtime_state = v_merged WHERE id = p_session_id;
  RETURN v_merged;
END;
$$;

-- One deliberation at a time. Returns TRUE for the caller that won the claim.
-- The TTL bounds a crashed pipeline: a claim older than it is free again.
CREATE OR REPLACE FUNCTION claim_meeting_deliberation(p_session_id UUID, p_ttl_seconds INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_claimed UUID;
BEGIN
  UPDATE meeting_sessions
  SET deliberating_until = NOW() + make_interval(secs => GREATEST(p_ttl_seconds, 1))
  WHERE id = p_session_id
    AND (deliberating_until IS NULL OR deliberating_until < NOW())
  RETURNING id INTO v_claimed;
  RETURN v_claimed IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION next_meeting_sequence_number(p_session_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_next INTEGER;
BEGIN
  UPDATE meeting_sessions
  SET next_sequence = COALESCE(next_sequence, 0) + 1
  WHERE id = p_session_id
  RETURNING next_sequence INTO v_next;
  RETURN v_next;
END;
$$;
