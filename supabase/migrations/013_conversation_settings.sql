-- ─── Conversation settings ──────────────────────────────────────────────────
-- Language, mediator personality and profanity, shared by every conversation
-- mode (invited intake, together, room/live, meeting mediation).
--
-- These live on `cases` because that is the one table all four modes already
-- hang off, so a setting chosen at setup follows the conversation into its
-- intake, its live session, its summaries and its final report without each mode
-- carrying a private copy that can drift.
--
-- Meeting Mediation keeps its own agent_* columns (010) for the axes that are
-- genuinely meeting-specific — voice gender, accent region, how often to
-- interrupt. Personality/language/profanity move here; see
-- src/lib/meeting/agentSettings.ts for how the two compose.
--
-- Backward compatibility: every column has a default matching the documented
-- product default (English, Diplomat, profanity off), so existing rows and any
-- code path that has not yet been updated keeps working unchanged.

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS conversation_language TEXT NOT NULL DEFAULT 'english'
    CHECK (conversation_language IN ('english', 'hindi', 'hinglish')),
  ADD COLUMN IF NOT EXISTS mediator_personality TEXT NOT NULL DEFAULT 'diplomat'
    CHECK (mediator_personality IN ('diplomat', 'straight_shooter', 'deal_maker')),
  ADD COLUMN IF NOT EXISTS allow_profanity BOOLEAN NOT NULL DEFAULT FALSE,
  -- Only meaningful for Hindi/Hinglish in text modes; NULL means "use the
  -- language's default" (Devanagari for Hindi, Roman for Hinglish).
  ADD COLUMN IF NOT EXISTS text_script TEXT
    CHECK (text_script IS NULL OR text_script IN ('devanagari', 'roman')),
  -- Incremented on every change to the three settings above. Acceptances are
  -- recorded against a specific value, so an agreement gathered under one
  -- configuration cannot authorise a different one.
  ADD COLUMN IF NOT EXISTS conversation_settings_version INTEGER NOT NULL DEFAULT 1;

-- Profanity is a Straight Shooter-only control. Enforced in the database as well
-- as in normalizeConversationSettings(), so no code path — including a
-- hand-crafted API call or a future mode that forgets — can persist a
-- combination the UI never offered.
ALTER TABLE cases
  DROP CONSTRAINT IF EXISTS cases_profanity_requires_straight_shooter;
ALTER TABLE cases
  ADD CONSTRAINT cases_profanity_requires_straight_shooter
  CHECK (allow_profanity = FALSE OR mediator_personality = 'straight_shooter');

-- ─── Participant acceptance ─────────────────────────────────────────────────
-- Who has agreed to which version of the settings.
--
-- A separate table rather than columns on each mode's participant table: there
-- are four of those (participants, room_participants, meeting_participants, and
-- together_sessions' person_a/person_b), they have no common key, and two of the
-- four have no per-person row at all in shared-device mode. One table keyed by a
-- mode-appropriate participant reference keeps the acceptance rules in a single
-- place instead of four subtly different ones.

CREATE TABLE IF NOT EXISTS conversation_settings_acceptances (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id           UUID NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  -- Identifies the accepting participant WITHIN this case, in whatever form the
  -- mode has: a participants.id / room_participants.id / meeting_participants.id,
  -- or a stable role key such as 'person_a' for Together, or 'room' for a
  -- shared-device confirmation covering everyone physically present.
  participant_ref   TEXT NOT NULL,
  settings_version  INTEGER NOT NULL,
  -- Agreeing to the style is not agreeing to swearing. Recorded separately so a
  -- general acceptance can never silently opt someone into profanity.
  accepted_profanity BOOLEAN NOT NULL DEFAULT FALSE,
  -- Set when someone actively rejects the proposal, so the organiser can be
  -- shown "declined" rather than "still waiting" and offer a revised proposal.
  declined_at       TIMESTAMPTZ,
  accepted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (case_id, participant_ref, settings_version)
);

CREATE INDEX IF NOT EXISTS idx_settings_acceptances_case
  ON conversation_settings_acceptances (case_id, settings_version);

ALTER TABLE conversation_settings_acceptances ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE conversation_settings_acceptances IS
  'Per-participant agreement to a specific conversation_settings_version. Profanity is tracked separately from general acceptance.';
COMMENT ON COLUMN cases.text_script IS
  'Script for written output in Hindi/Hinglish text modes. NULL = the language default. Irrelevant to voice modes.';
