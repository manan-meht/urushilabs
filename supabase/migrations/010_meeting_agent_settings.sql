-- Meeting-agent configuration + intervention telemetry.
--
-- Additive only. Every column is nullable or defaulted so meeting sessions created
-- before this migration keep working untouched — the application layer resolves
-- NULLs to DEFAULT_MEETING_AGENT_SETTINGS (see src/lib/meeting/agentSettings.ts).

-- ─── 1. Agent settings on the session ────────────────────────────────────────

ALTER TABLE meeting_sessions
  ADD COLUMN IF NOT EXISTS agent_personality        TEXT,
  ADD COLUMN IF NOT EXISTS agent_voice_gender       TEXT,
  ADD COLUMN IF NOT EXISTS agent_region             TEXT,
  ADD COLUMN IF NOT EXISTS agent_language           TEXT,
  ADD COLUMN IF NOT EXISTS agent_intervention_level TEXT,
  ADD COLUMN IF NOT EXISTS agent_language_style     TEXT;

ALTER TABLE meeting_sessions DROP CONSTRAINT IF EXISTS meeting_sessions_agent_personality_check;
ALTER TABLE meeting_sessions ADD CONSTRAINT meeting_sessions_agent_personality_check
  CHECK (agent_personality IS NULL OR agent_personality IN ('chair', 'straight_shooter'));

ALTER TABLE meeting_sessions DROP CONSTRAINT IF EXISTS meeting_sessions_agent_voice_gender_check;
ALTER TABLE meeting_sessions ADD CONSTRAINT meeting_sessions_agent_voice_gender_check
  CHECK (agent_voice_gender IS NULL OR agent_voice_gender IN ('female', 'male'));

ALTER TABLE meeting_sessions DROP CONSTRAINT IF EXISTS meeting_sessions_agent_region_check;
ALTER TABLE meeting_sessions ADD CONSTRAINT meeting_sessions_agent_region_check
  CHECK (agent_region IS NULL OR agent_region IN ('american', 'singaporean', 'indian'));

ALTER TABLE meeting_sessions DROP CONSTRAINT IF EXISTS meeting_sessions_agent_language_check;
ALTER TABLE meeting_sessions ADD CONSTRAINT meeting_sessions_agent_language_check
  CHECK (agent_language IS NULL OR agent_language IN ('english', 'hindi', 'hinglish', 'auto'));

ALTER TABLE meeting_sessions DROP CONSTRAINT IF EXISTS meeting_sessions_agent_intervention_level_check;
ALTER TABLE meeting_sessions ADD CONSTRAINT meeting_sessions_agent_intervention_level_check
  CHECK (agent_intervention_level IS NULL OR agent_intervention_level IN ('observer', 'facilitator', 'chair'));

ALTER TABLE meeting_sessions DROP CONSTRAINT IF EXISTS meeting_sessions_agent_language_style_check;
ALTER TABLE meeting_sessions ADD CONSTRAINT meeting_sessions_agent_language_style_check
  CHECK (agent_language_style IS NULL OR agent_language_style IN ('clean', 'direct', 'unfiltered'));

-- ─── 2. Live conversational state ────────────────────────────────────────────

-- Lightweight structured meeting state (speaking time, circularity, escalation,
-- unanswered questions, ...) so the intervention engine does not have to re-derive
-- everything from the full transcript on every incoming utterance (spec §9, §23).
ALTER TABLE meeting_sessions
  ADD COLUMN IF NOT EXISTS runtime_state JSONB;

-- Human override of Urushi's participation ("Urushi, hold on" / "Urushi, step in").
-- Decays rather than permanently disabling Urushi (spec §14).
ALTER TABLE meeting_sessions
  ADD COLUMN IF NOT EXISTS participation_override            TEXT,
  ADD COLUMN IF NOT EXISTS participation_override_expires_at TIMESTAMPTZ;

ALTER TABLE meeting_sessions DROP CONSTRAINT IF EXISTS meeting_sessions_participation_override_check;
ALTER TABLE meeting_sessions ADD CONSTRAINT meeting_sessions_participation_override_check
  CHECK (participation_override IS NULL OR participation_override IN ('NORMAL', 'BACK_OFF', 'STEP_IN'));

-- ─── 3. Intervention telemetry ───────────────────────────────────────────────

-- Structured classification only — never private chain-of-thought (spec §25).
ALTER TABLE meeting_interventions
  ADD COLUMN IF NOT EXISTS intervention_reason TEXT,
  ADD COLUMN IF NOT EXISTS intervention_style  TEXT,
  ADD COLUMN IF NOT EXISTS urgency             TEXT,
  ADD COLUMN IF NOT EXISTS confidence          NUMERIC(4, 3),
  ADD COLUMN IF NOT EXISTS latency_ms          INTEGER,
  -- True when the engine wanted to speak but the budget/cooldown/threshold
  -- suppressed it. Lets us tune thresholds against real meetings.
  ADD COLUMN IF NOT EXISTS suppressed          BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE meeting_interventions DROP CONSTRAINT IF EXISTS meeting_interventions_intervention_style_check;
ALTER TABLE meeting_interventions ADD CONSTRAINT meeting_interventions_intervention_style_check
  CHECK (intervention_style IS NULL OR intervention_style IN ('NATURAL', 'POLITE_INTERRUPT', 'HARD_INTERRUPT'));

ALTER TABLE meeting_interventions DROP CONSTRAINT IF EXISTS meeting_interventions_urgency_check;
ALTER TABLE meeting_interventions ADD CONSTRAINT meeting_interventions_urgency_check
  CHECK (urgency IS NULL OR urgency IN ('LOW', 'MEDIUM', 'HIGH'));

-- Suppressed rows are the common case once a meeting gets going; keep the
-- "what did Urushi actually say" query fast.
CREATE INDEX IF NOT EXISTS idx_meeting_interventions_session_spoken
  ON meeting_interventions(session_id, triggered_at)
  WHERE suppressed = FALSE;

-- ─── 4. Transcript labelling ─────────────────────────────────────────────────

-- Lets a transcript row be traced back to why Urushi spoke (spec §24). Internal
-- only — never surfaced to meeting participants.
ALTER TABLE meeting_transcript_segments
  ADD COLUMN IF NOT EXISTS intervention_reason TEXT,
  ADD COLUMN IF NOT EXISTS intervention_style  TEXT;
