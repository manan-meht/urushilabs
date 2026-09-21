-- ─── GIVE_VERDICT ───────────────────────────────────────────────────────────
-- An action for taking a position on who is right.
--
-- The Straight Shooter's entire proposition is that it tells people whose
-- argument holds up. Its prompt module says so at length, participants choose it
-- for exactly that, and it consistently would not do it — it asked for more
-- detail, proposed process, or filed another issue instead.
--
-- The prompt was not the reason. The controller must return one of a fixed list
-- of actions, and that list had no verb for rendering a judgement: LISTEN,
-- CLARIFY, INVITE_PARTICIPANT, REFRAME, DEESCALATE, IDENTIFY_ISSUE, SUMMARIZE,
-- PROPOSE_COMPROMISE, CONFIRM_AGREEMENT, MOVE_TO_NEXT_ISSUE, END_SESSION. Every
-- one of those is a facilitation move. Asked to judge, the model picked the
-- closest available verb and wrote facilitator text to fit it, which is why
-- three rounds of increasingly emphatic prompt instructions changed nothing.
--
-- Available to every personality — the Diplomat is told to say plainly when
-- someone has been treated unfairly, and the Deal Maker to say so when a
-- commitment was broken. What differs is how early each one reaches for it, and
-- that belongs in the personality modules rather than in the schema.
--
-- Deliberately separate from IDENTIFY_ISSUE: naming what the disagreement is
-- about and saying who is right about it are different acts, and collapsing them
-- is what produced issue rows whose titles were really verdicts.

ALTER TABLE room_interventions
  DROP CONSTRAINT IF EXISTS room_interventions_action_check;

ALTER TABLE room_interventions
  ADD CONSTRAINT room_interventions_action_check CHECK (action IN (
    'LISTEN', 'CLARIFY', 'INVITE_PARTICIPANT', 'REFRAME', 'DEESCALATE',
    'IDENTIFY_ISSUE', 'SUMMARIZE', 'PROPOSE_COMPROMISE', 'CONFIRM_AGREEMENT',
    'MOVE_TO_NEXT_ISSUE', 'END_SESSION', 'GIVE_VERDICT'
  ));

COMMENT ON COLUMN room_interventions.action IS
  'The mediation move. GIVE_VERDICT means Urushi took a position on who is right; it is a spoken judgement, not a change to issue or agreement state.';
