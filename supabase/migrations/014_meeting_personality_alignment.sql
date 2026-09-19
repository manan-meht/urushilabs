-- ─── Align Meeting Mediation with the shared personality set ────────────────
-- Meeting Mediation shipped with its own two personalities, `chair` and
-- `straight_shooter`, before conversation settings existed. The product now has
-- three, shared by every mode: diplomat, straight_shooter, deal_maker.
--
-- `chair` becomes `diplomat`. They are the same role — the calm, structured
-- default that keeps a conversation moving — and keeping both would leave the
-- meeting setup screen offering a personality no other mode has, described in
-- different words, while the shared one sat unused.
--
-- What is NOT merged: agent_voice_gender, agent_region and agent_intervention_level
-- stay meeting-only. Voice and accent have no meaning in a text intake, and how
-- OFTEN to interrupt is a genuinely different axis from HOW to speak — that
-- separation is load-bearing in the intervention tuning and is preserved.
--
-- agent_language_style (clean/direct/unfiltered) also stays: the shared model
-- has a boolean allow_profanity, and this column refines it for meetings into
-- mild vs strong. Off is off in both; see src/lib/meeting/agentSettings.ts.

-- The CHECK has to go before the data can be rewritten to values it forbids.
ALTER TABLE meeting_sessions
  DROP CONSTRAINT IF EXISTS meeting_sessions_agent_personality_check;

UPDATE meeting_sessions
SET agent_personality = 'diplomat'
WHERE agent_personality = 'chair';

ALTER TABLE meeting_sessions
  ADD CONSTRAINT meeting_sessions_agent_personality_check
  CHECK (agent_personality IS NULL OR agent_personality IN ('diplomat', 'straight_shooter', 'deal_maker'));

-- Carry each meeting's existing personality and language choice onto its case,
-- so sessions configured before conversation settings existed keep the mediator
-- they were set up with — in their reports and summaries too, not just live.
--
-- agent_language 'auto' has no equivalent in the shared model, which is a
-- deliberate three-way choice rather than a detection mode; those cases keep the
-- English default. Language was also only ever applied to the Indian region
-- (see effectiveLanguage), so anything else is left alone.
UPDATE cases c
SET
  mediator_personality = COALESCE(m.agent_personality, c.mediator_personality),
  conversation_language = CASE
    WHEN m.agent_region = 'indian' AND m.agent_language IN ('english', 'hindi', 'hinglish')
      THEN m.agent_language
    ELSE c.conversation_language
  END,
  allow_profanity = (
    COALESCE(m.agent_personality, 'diplomat') = 'straight_shooter'
    AND COALESCE(m.agent_language_style, 'clean') <> 'clean'
  )
FROM meeting_sessions m
WHERE m.case_id = c.id;

COMMENT ON COLUMN meeting_sessions.agent_language_style IS
  'Meeting-only refinement of cases.allow_profanity: clean = off, direct = mild, unfiltered = strong. Off in either place means off.';
