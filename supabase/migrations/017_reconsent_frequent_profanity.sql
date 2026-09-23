-- ─── Re-consent: strong language is now the mediator's normal register ──────
-- The profanity setting has not changed shape, and neither has its safety
-- boundary. What has changed is how often it is exercised, and by enough that
-- the previous description was no longer true.
--
-- Participants agreed to a toggle described as "May include words like 'fuck'
-- and 'bhenchod' for emphasis or frustration" — wording that reads as
-- occasional, and matched a prompt that told the mediator escalation was earned
-- and that most turns needed nothing stronger. Measured, that produced a
-- mediator which swore zero times across an entire escalated argument.
--
-- Ordinary profanity is now the default register rather than an earned
-- escalation, and measures at roughly three turns in four. That is a materially
-- stronger thing to agree to than what anyone was shown, even though no
-- individual word is new and nothing about targeting has relaxed.
--
-- This is the same judgement as migration 015, which bumped the version when a
-- single family-based expression was added: carrying an old agreement forward
-- across a change in what the setting MEANS is the silent opt-in the acceptance
-- mechanism exists to prevent. Frequency is part of the meaning. Someone who
-- said yes to occasional swearing has not said yes to constant swearing, and the
-- failure would be invisible — the session would simply swear far more than
-- anyone agreed to, in a room, out loud.
--
-- Bumping conversation_settings_version invalidates every prior acceptance for
-- these cases through the existing mechanism: evaluateAcceptance counts only
-- acceptances recorded against the CURRENT version, so profanityPermitted goes
-- false until everyone agrees again, and effectiveSettings forces allow_profanity
-- off in the meantime. The mediator degrades to clean language rather than
-- blocking the conversation.
--
-- Scoped to cases that actually have profanity enabled, as in 015. A case with
-- it switched off is unaffected by a change in how often it would have sworn,
-- and invalidating its participants' agreement to language and personality would
-- make them re-accept for nothing.

UPDATE cases
SET conversation_settings_version = conversation_settings_version + 1
WHERE allow_profanity = TRUE;

-- Old acceptance rows are left in place, as in 015: they are an accurate record
-- of what each person agreed to at the time, and nothing reads them for a
-- version that is no longer current.
