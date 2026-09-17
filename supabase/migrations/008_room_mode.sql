-- ─── Live Mediation ("Room Mode") ──────────────────────────────────────────────
-- Additive migration. Does not modify or drop any existing table's data or rows.

-- 1. Conversation mode on cases — widen existing CHECK to add 'room'
ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_conversation_mode_check;
ALTER TABLE cases ADD CONSTRAINT cases_conversation_mode_check
  CHECK (conversation_mode IN ('invited', 'together', 'room'));

-- 2. Room session stage
CREATE TYPE room_stage AS ENUM (
  'setup',
  'consent',
  'ready',
  'live',
  'paused',
  'completed'
);

-- 3. Room sessions (one per room-mode case)
CREATE TABLE room_sessions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                 UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  stage                   room_stage NOT NULL DEFAULT 'setup',
  participant_count       INTEGER NOT NULL CHECK (participant_count IN (2, 3)),
  topic                   TEXT NOT NULL,
  context_summary         TEXT,
  -- Optional: this room was launched from an existing case's context (async intake or a
  -- prior together session) instead of collecting background from scratch.
  source_case_id          UUID REFERENCES cases(id) ON DELETE SET NULL,
  current_issue_id        UUID,
  conversation_summary    TEXT,
  consent_completed_at    TIMESTAMPTZ,
  realtime_session_active BOOLEAN NOT NULL DEFAULT false,
  started_at              TIMESTAMPTZ,
  ended_at                TIMESTAMPTZ,
  paused_at               TIMESTAMPTZ,
  final_report            JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (case_id)
);

-- 4. Room participants (2 or 3 per session)
CREATE TABLE room_participants (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         UUID NOT NULL REFERENCES room_sessions(id) ON DELETE CASCADE,
  case_id            UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  participant_index  INTEGER NOT NULL CHECK (participant_index IN (1, 2, 3)),
  name               TEXT NOT NULL,
  -- Reserved for future per-participant pre-meeting context submission (not exposed in V1 UI).
  pre_context        TEXT,
  -- Diarization mapping — probabilistic, set/updated during and after speaker calibration.
  speaker_label      TEXT,
  speaker_confidence NUMERIC,
  calibrated_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, participant_index)
);

-- 5. Room issues (same shape/philosophy as together_issues — one at a time)
CREATE TABLE room_issues (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID NOT NULL REFERENCES room_sessions(id) ON DELETE CASCADE,
  case_id             UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  neutral_description TEXT NOT NULL,
  priority            INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'discussing', 'agreed', 'partial', 'unresolved', 'skipped')),
  resolution          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE room_sessions
  ADD CONSTRAINT room_sessions_current_issue_id_fkey
  FOREIGN KEY (current_issue_id) REFERENCES room_issues(id) ON DELETE SET NULL;

-- 6. Room agreements — proposed by Urushi, confirmed only on explicit affirmation.
-- agreed_by / awaiting hold arrays of room_participants.id (as text); never inferred from silence.
CREATE TABLE room_agreements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL REFERENCES room_sessions(id) ON DELETE CASCADE,
  case_id       UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  issue_id      UUID REFERENCES room_issues(id) ON DELETE SET NULL,
  description   TEXT NOT NULL,
  agreed_by     JSONB NOT NULL DEFAULT '[]'::jsonb,
  awaiting      JSONB NOT NULL DEFAULT '[]'::jsonb,
  confirmed     BOOLEAN NOT NULL DEFAULT false,
  confirmed_at  TIMESTAMPTZ,
  proposed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Room transcript segments — plaintext, same reasoning as together_messages
-- (all participants are physically present and consented to Urushi listening).
CREATE TABLE room_transcript_segments (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                UUID NOT NULL REFERENCES room_sessions(id) ON DELETE CASCADE,
  case_id                   UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  participant_id            UUID REFERENCES room_participants(id) ON DELETE SET NULL,
  diarization_speaker_label TEXT,
  speaker_confidence        NUMERIC,
  role                      TEXT NOT NULL CHECK (role IN ('participant', 'assistant')),
  content                   TEXT NOT NULL,
  sequence_number           INTEGER NOT NULL,
  started_at                TIMESTAMPTZ,
  ended_at                  TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Room interventions — the mediation controller's decision log (LISTEN is not persisted
-- as a row by default; see application-level sampling — kept here for spoken interventions
-- and any decision the caller chooses to audit).
CREATE TABLE room_interventions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES room_sessions(id) ON DELETE CASCADE,
  case_id      UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  action       TEXT NOT NULL CHECK (action IN (
    'LISTEN', 'CLARIFY', 'INVITE_PARTICIPANT', 'REFRAME', 'DEESCALATE',
    'IDENTIFY_ISSUE', 'SUMMARIZE', 'PROPOSE_COMPROMISE', 'CONFIRM_AGREEMENT',
    'MOVE_TO_NEXT_ISSUE', 'END_SESSION'
  )),
  reasoning    TEXT,
  spoken_text  TEXT,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX idx_room_sessions_case_id           ON room_sessions(case_id);
CREATE INDEX idx_room_participants_session_id    ON room_participants(session_id);
CREATE INDEX idx_room_issues_session_id          ON room_issues(session_id);
CREATE INDEX idx_room_agreements_session_id      ON room_agreements(session_id);
CREATE INDEX idx_room_transcript_session_id      ON room_transcript_segments(session_id, sequence_number);
CREATE INDEX idx_room_interventions_session_id   ON room_interventions(session_id, triggered_at);
CREATE INDEX idx_cases_conversation_mode_room    ON cases(conversation_mode) WHERE conversation_mode = 'room';

-- ─── updated_at triggers (reuses update_updated_at() from 006_together_mode.sql) ──
CREATE TRIGGER room_sessions_updated_at
  BEFORE UPDATE ON room_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER room_issues_updated_at
  BEFORE UPDATE ON room_issues
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER room_agreements_updated_at
  BEFORE UPDATE ON room_agreements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── RLS (service role only — access enforced in route handlers, matching together_mode) ──
ALTER TABLE room_sessions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_participants         ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_issues               ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_agreements           ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_transcript_segments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_interventions        ENABLE ROW LEVEL SECURITY;
