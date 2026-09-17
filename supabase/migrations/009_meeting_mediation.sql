-- ─── Meeting Mediation (fourth conversation mode) ─────────────────────────────
-- Additive migration. Does not modify or drop any existing table's data or rows,
-- other than widening cases.conversation_mode's CHECK constraint (same pattern
-- used by 006_together_mode.sql and 008_room_mode.sql).
--
-- "Recall" (the meeting-bot transport provider) is intentionally kept out of
-- Urushi's primary identifiers. Urushi owns meeting_sessions.id; all
-- provider-specific IDs are namespaced under provider_* columns so a future
-- transport (native Zoom/Meet, another vendor) can be added without a
-- migration to core identifiers.

ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_conversation_mode_check;
ALTER TABLE cases ADD CONSTRAINT cases_conversation_mode_check
  CHECK (conversation_mode IN ('invited', 'together', 'room', 'meeting_mediation'));

-- 1. Meeting session — one per case, mirrors room_sessions/together_sessions shape.
CREATE TABLE meeting_sessions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                 UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  status                  TEXT NOT NULL DEFAULT 'setup' CHECK (status IN (
    'setup', 'awaiting_preparation', 'ready', 'bot_requested', 'joining',
    'waiting_room', 'in_meeting', 'ended', 'generating_report', 'completed',
    'failed', 'disconnected', 'cancelled'
  )),
  participant_count       INTEGER NOT NULL CHECK (participant_count IN (2, 3)),
  topic                   TEXT NOT NULL,
  context_summary         TEXT,

  -- Meeting details (§7/§9 of the spec)
  meeting_platform        TEXT CHECK (meeting_platform IN ('google_meet', 'zoom')),
  meeting_url             TEXT,
  scheduled_start_at      TIMESTAMPTZ,
  timezone                TEXT,
  start_now               BOOLEAN NOT NULL DEFAULT false,

  -- Transport provider (Recall today; kept generic — see module comment above)
  bot_provider            TEXT NOT NULL DEFAULT 'recall' CHECK (bot_provider IN ('recall')),
  provider_bot_id         TEXT,
  provider_meeting_id     TEXT,
  provider_metadata       JSONB,

  current_issue_id        UUID,
  conversation_summary    TEXT,
  consent_completed_at    TIMESTAMPTZ,

  requested_at            TIMESTAMPTZ,
  joined_at               TIMESTAMPTZ,
  ended_at                TIMESTAMPTZ,
  failure_reason          TEXT,

  final_report            JSONB,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (case_id)
);

-- 2. Meeting participants (2 or 3). Each may optionally submit a private
-- pre-meeting perspective — encrypted with the same AES-256-GCM scheme as
-- `submissions` (see src/lib/crypto.ts) and never disclosed verbatim during
-- the meeting; Urushi reframes it neutrally (see meeting mediation prompt).
CREATE TABLE meeting_participants (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id               UUID NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
  case_id                  UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  participant_index        INTEGER NOT NULL CHECK (participant_index IN (1, 2, 3)),
  name                     TEXT NOT NULL,
  email                    TEXT,
  is_initiator             BOOLEAN NOT NULL DEFAULT false,

  invite_token_hash        TEXT,
  invited_at               TIMESTAMPTZ,

  encrypted_context        TEXT,
  context_iv               TEXT,
  context_tag              TEXT,
  context_submitted_at     TIMESTAMPTZ,

  consented_at             TIMESTAMPTZ,

  -- Maps this participant to the meeting platform's own identity once known
  -- (from provider webhook/transcript events) — probabilistic, never certain.
  provider_participant_id  TEXT,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, participant_index)
);

-- 3. Issues — same lifecycle as together_issues/room_issues.
CREATE TABLE meeting_issues (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            UUID NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
  case_id               UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  neutral_description   TEXT NOT NULL,
  priority              INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'discussing', 'agreed', 'partial', 'unresolved', 'skipped')),
  resolution            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE meeting_sessions
  ADD CONSTRAINT meeting_sessions_current_issue_id_fkey
  FOREIGN KEY (current_issue_id) REFERENCES meeting_issues(id) ON DELETE SET NULL;

-- 4. Agreements — same affirmation model as room_agreements (never inferred from silence).
CREATE TABLE meeting_agreements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
  case_id      UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  issue_id     UUID REFERENCES meeting_issues(id) ON DELETE SET NULL,
  description  TEXT NOT NULL,
  agreed_by    JSONB NOT NULL DEFAULT '[]'::jsonb,
  awaiting     JSONB NOT NULL DEFAULT '[]'::jsonb,
  confirmed    BOOLEAN NOT NULL DEFAULT false,
  confirmed_at TIMESTAMPTZ,
  proposed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Transcript segments — speaker-attributed, normalized from whatever the meeting
-- provider sends. Plaintext, same reasoning as room_transcript_segments (participants
-- explicitly consented to Urushi listening/processing the meeting). Kept minimal-retention
-- per spec §32/§33 — this is Urushi's own record, not reliant on the provider as a
-- system of record.
CREATE TABLE meeting_transcript_segments (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                UUID NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
  case_id                   UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  participant_id            UUID REFERENCES meeting_participants(id) ON DELETE SET NULL,
  provider_participant_id   TEXT,
  speaker_name              TEXT,
  role                      TEXT NOT NULL CHECK (role IN ('participant', 'assistant')),
  content                   TEXT NOT NULL,
  sequence_number           INTEGER NOT NULL,
  confidence                NUMERIC,
  started_at                TIMESTAMPTZ,
  ended_at                  TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Interventions — the mediation controller's decision log, same shape as room_interventions.
CREATE TABLE meeting_interventions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
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

-- 7. Raw provider webhook event log — separate from Urushi's own IDs (spec §16),
-- and the mechanism that makes webhook processing idempotent (spec §35): a
-- unique constraint on (bot_provider, provider_event_id) means a retried
-- webhook delivery is a harmless duplicate insert attempt, not reprocessed.
CREATE TABLE meeting_provider_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         UUID REFERENCES meeting_sessions(id) ON DELETE CASCADE,
  bot_provider       TEXT NOT NULL DEFAULT 'recall',
  provider_event_id  TEXT NOT NULL,
  event_type         TEXT NOT NULL,
  payload            JSONB,
  processed_at       TIMESTAMPTZ,
  error_message      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bot_provider, provider_event_id)
);

-- 8. Per-session usage/cost accounting (spec §39) — internal only, never shown to customers.
CREATE TABLE meeting_usage (
  session_id                UUID PRIMARY KEY REFERENCES meeting_sessions(id) ON DELETE CASCADE,
  meeting_duration_seconds  INTEGER,
  transcript_segment_count  INTEGER NOT NULL DEFAULT 0,
  intervention_count        INTEGER NOT NULL DEFAULT 0,
  openai_input_tokens       INTEGER NOT NULL DEFAULT 0,
  openai_output_tokens      INTEGER NOT NULL DEFAULT 0,
  generated_audio_seconds   NUMERIC NOT NULL DEFAULT 0,
  provider_cost_usd         NUMERIC,
  estimated_total_cost_usd  NUMERIC,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX idx_meeting_sessions_case_id           ON meeting_sessions(case_id);
CREATE INDEX idx_meeting_sessions_status            ON meeting_sessions(status);
CREATE INDEX idx_meeting_participants_session_id    ON meeting_participants(session_id);
CREATE INDEX idx_meeting_issues_session_id          ON meeting_issues(session_id);
CREATE INDEX idx_meeting_agreements_session_id      ON meeting_agreements(session_id);
CREATE INDEX idx_meeting_transcript_session_id      ON meeting_transcript_segments(session_id, sequence_number);
CREATE INDEX idx_meeting_interventions_session_id   ON meeting_interventions(session_id, triggered_at);
CREATE INDEX idx_meeting_provider_events_session_id ON meeting_provider_events(session_id);
CREATE INDEX idx_cases_conversation_mode_meeting    ON cases(conversation_mode) WHERE conversation_mode = 'meeting_mediation';

-- ─── updated_at triggers (reuses update_updated_at() from 006_together_mode.sql) ──
CREATE TRIGGER meeting_sessions_updated_at
  BEFORE UPDATE ON meeting_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER meeting_issues_updated_at
  BEFORE UPDATE ON meeting_issues
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER meeting_agreements_updated_at
  BEFORE UPDATE ON meeting_agreements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER meeting_usage_updated_at
  BEFORE UPDATE ON meeting_usage
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── RLS (service role only — access enforced in route handlers, matching room/together) ──
ALTER TABLE meeting_sessions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_participants         ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_issues               ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_agreements           ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_transcript_segments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_interventions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_provider_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_usage                ENABLE ROW LEVEL SECURITY;
