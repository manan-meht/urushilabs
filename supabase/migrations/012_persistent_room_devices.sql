-- ─── Persistent room devices ────────────────────────────────────────────────
-- Makes a paired hardware client (e.g. the Raspberry Pi room device) belong to a
-- USER rather than to a single session.
--
-- Before this, room_devices.session_id was NOT NULL, so a device was scoped to
-- exactly one session. Every new mediation meant: pair again in the browser, copy
-- a fresh bearer token, SSH into the device, rewrite its .env, and restart the
-- client by hand. That is untenable for a box that is meant to sit on a table and
-- be switched on.
--
-- After this, the device is paired once. session_id becomes its CURRENT
-- ASSIGNMENT (NULL = idle), which the owner sets from the session's ready screen;
-- the device polls for that assignment and joins by itself.
--
-- Auth is unchanged in shape: a device token still only ever grants access to the
-- one session it is currently assigned to (see requireRoomSessionByDeviceToken).
-- An idle device's token grants nothing.

-- Who owns the device. Previously implied transitively through case_id -> cases.user_id,
-- which stops working once a device can exist with no session and no case.
ALTER TABLE room_devices ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

UPDATE room_devices d
SET user_id = c.user_id
FROM cases c
WHERE d.case_id = c.id
  AND d.user_id IS NULL;

-- A row that couldn't be backfilled has no identifiable owner and could never be
-- assigned to a session. Rather than delete it, stop and say so: on this data the
-- backfill above covers every row, so hitting this means the assumption behind
-- this migration is wrong, and that is worth a human looking at rather than a
-- DELETE running unattended.
DO $$
DECLARE ownerless INTEGER;
BEGIN
  SELECT COUNT(*) INTO ownerless FROM room_devices WHERE user_id IS NULL;
  IF ownerless > 0 THEN
    RAISE EXCEPTION
      'room_devices has % row(s) with no resolvable owner. Inspect them before re-running: SELECT id, session_id, case_id, revoked_at FROM room_devices WHERE user_id IS NULL;',
      ownerless;
  END IF;
END $$;

ALTER TABLE room_devices ALTER COLUMN user_id SET NOT NULL;

-- session_id/case_id become the current assignment rather than an identity.
ALTER TABLE room_devices ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE room_devices ALTER COLUMN case_id DROP NOT NULL;

-- Listing a user's devices on the ready screen, and resolving "which device is
-- assigned to this session" — both hot paths for the new launch flow.
CREATE INDEX IF NOT EXISTS idx_room_devices_user_id ON room_devices(user_id) WHERE revoked_at IS NULL;

-- A session can be driven by at most one hardware device at a time. Without this,
-- two Pis assigned to the same session would both stream audio into it — which is
-- exactly the failure we hit with the browser live page opening a second Realtime
-- client alongside the device.
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_devices_one_per_session
  ON room_devices(session_id)
  WHERE session_id IS NOT NULL AND revoked_at IS NULL;

COMMENT ON COLUMN room_devices.session_id IS
  'Session this device is CURRENTLY assigned to, or NULL when idle. Set from the ready screen; the device polls GET /api/room/device/assignment to discover it.';
