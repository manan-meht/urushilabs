-- ─── Room Mode device auth ──────────────────────────────────────────────────
-- Bearer-token auth for non-browser clients of a live Room Mode session (e.g. a
-- Raspberry Pi hardware client). Additive — does not touch any existing table.
--
-- Only the browser owner (cookie-authenticated) can mint or revoke a device
-- token, via /api/room/sessions/[id]/devices. Devices only ever authenticate
-- live-session operations (realtime-token, intervene, calibrate, pause, resume,
-- complete, status) — consent and agreement confirmation stay owner/cookie-only
-- by design (see src/lib/room/getSession.ts).

CREATE TABLE room_devices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID NOT NULL REFERENCES room_sessions(id) ON DELETE CASCADE,
  case_id           UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  -- SHA-256 hex of the bearer token — same pattern as together_sessions.person_b_token_hash
  -- and cases.invitation_token_hash. The plaintext token is returned exactly once,
  -- at pairing time, and never stored.
  device_token_hash TEXT NOT NULL UNIQUE,
  label             TEXT,
  paired_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_room_devices_session_id ON room_devices(session_id);
-- Fast token lookup on every device-authenticated request; excludes revoked
-- devices since those should never resolve.
CREATE INDEX idx_room_devices_token_hash ON room_devices(device_token_hash) WHERE revoked_at IS NULL;

-- ─── RLS (service role only — access enforced in route handlers, matching room_mode) ──
ALTER TABLE room_devices ENABLE ROW LEVEL SECURITY;
