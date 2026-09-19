-- ─── Re-consent for strong profanity ────────────────────────────────────────
-- The profanity setting has not changed shape, but what it MEANS has changed
-- materially. It was described to participants as "Urushi may use strong
-- language for emphasis. No personal abuse." It now permits, in Hindi and
-- Hinglish, an occasional family-based exclamation ("bhenchod") as an
-- interjection about a circular conversation.
--
-- Anyone who agreed to the earlier wording agreed to something weaker. Carrying
-- that agreement forward would be exactly the silent opt-in the whole acceptance
-- mechanism exists to prevent — and the failure would be invisible, because the
-- session would simply start swearing more strongly than anyone had said yes to.
--
-- Bumping conversation_settings_version invalidates every prior acceptance for
-- these cases, using the existing mechanism rather than inventing a second one:
-- evaluateAcceptance only counts acceptances recorded against the CURRENT
-- version, so profanityPermitted goes false until everyone agrees again, and
-- effectiveSettings forces allow_profanity off in the meantime.
--
-- Deliberately scoped to cases that actually have profanity enabled. A case with
-- it switched off is unaffected by the change in meaning, and invalidating its
-- participants' agreement to language and personality would make them re-accept
-- for nothing.

UPDATE cases
SET conversation_settings_version = conversation_settings_version + 1
WHERE allow_profanity = TRUE;

-- Leaves the old acceptance rows in place rather than deleting them: they are an
-- accurate record of what each person agreed to at the time, and nothing reads
-- them for a version that is no longer current.

COMMENT ON COLUMN cases.conversation_settings_version IS
  'Incremented whenever the settings change, or whenever what an existing setting MEANS changes materially (see migration 015). Acceptances are recorded against a specific value, so a bump invalidates prior agreement.';
