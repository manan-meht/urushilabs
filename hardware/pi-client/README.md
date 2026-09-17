# Urushi Raspberry Pi hardware client

Turns a Raspberry Pi + USB conference speakerphone (built and tested here against
an EMEET OfficeCore M0 Plus) into another client of an existing Urushi Live
Mediation session — no mediation intelligence lives here. See
`urushi_pi/__init__.py` for the exact boundary, and the root repo's
architecture notes for the full design.

```
EMEET mic -> this client -> OpenAI Realtime API (WebRTC) -> Urushi backend
  (/api/room/sessions/[id]/intervene — the real mediation controller)
-> OpenAI Realtime API (speech) -> this client -> EMEET speaker
```

## Setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

`requirements.txt`'s pins were chosen so this installs entirely from prebuilt
wheels (verified on Raspberry Pi OS/Debian trixie, aarch64, Python 3.13) — no
`apt-get`, no compiling. If you see PyAV fail to build with an error like
`AV_OPT_TYPE_CHANNEL_LAYOUT undeclared`, your `aiortc`/`av` versions have drifted
apart from what's pinned here (that error means an old PyAV is trying to build
against a newer FFmpeg than it understands) — either keep the pins as-is, or if
you do need to change them, first run
`sudo apt-get install -y libavformat-dev libavcodec-dev libavdevice-dev libavutil-dev libavfilter-dev libswscale-dev libswresample-dev pkg-config`
so a from-source build has what it needs.

Fill in `.env`:
- `URUSHI_API_BASE_URL` — where the Urushi backend is reachable from the Pi. For
  local dev, use your Mac's LAN IP and dev-server port (shown in `npm run dev`'s
  output), e.g. `http://192.168.1.197:3010` — **not** `localhost`, which on the
  Pi means the Pi itself.
- `URUSHI_SESSION_ID` and `URUSHI_DEVICE_TOKEN` — from the "Pair a hardware
  device" panel on the Ready screen in the browser, *after* completing setup and
  consent for a Live Mediation session there.

Confirm the EMEET device is visible:
```bash
python3 -m sounddevice
```
Look for "EMEET OfficeCore M0 Plus" (or similar) in the list; note its index or
name and set `URUSHI_INPUT_DEVICE` / `URUSHI_OUTPUT_DEVICE` in `.env` if it
isn't already the system default.

## Running

```bash
python3 main.py
```

- If any participants haven't been calibrated yet, it prompts for each one by
  name ("Manan, please say hello now...") over the console — same probabilistic
  mapping the browser's calibration step does, just without a touchscreen.
- Once running: talk normally. LISTEN is silent by design — most turns produce
  no output at all. When the backend decides Urushi should speak, you'll see a
  log line and hear it over the speaker.
- **Ctrl+C** ends the session cleanly: stops the WebRTC connection, calls the
  backend's `/complete` endpoint, and prints the summary.

## What this client does NOT contain

- No mediation prompts, no LISTEN/INTERVENE judgment, no independent
  conversation state — all of that is the existing `mediationController.ts` /
  `interventionGuardrails.ts` server-side. This client only forwards transcript
  text and plays back what it's told to say.
- No separate OpenAI mediation agent. The only OpenAI calls made *from* the Pi
  are the WebRTC media/transcription session itself — the actual LISTEN vs.
  INTERVENE decision and Urushi's spoken-line generation happen server-side via
  a plain REST call to `/intervene`.

## Project layout

Pure logic (no hardware dependency — importable and unit-testable without
`aiortc`/`sounddevice` installed):
- `urushi_pi/config.py` — env var loading/validation
- `urushi_pi/reconnect.py` — reconnection backoff schedule
- `urushi_pi/realtime_events.py` — OpenAI Realtime data-channel event parsing
- `urushi_pi/api_client.py` — REST client for the Urushi backend (uses `aiohttp`, no audio libs)

Hardware-dependent:
- `urushi_pi/audio_track.py` — mic capture / speaker playback (`sounddevice`, `av`)
- `urushi_pi/realtime_audio.py` — the WebRTC session to OpenAI (`aiortc`) — the
  Python equivalent of `src/lib/room/realtimeAudioProvider.ts`
- `urushi_pi/room_session.py` — orchestration, the equivalent of
  `src/lib/room/roomSessionClient.ts`
- `urushi_pi/calibration.py` — console-driven speaker calibration

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```

Only the pure-logic modules are covered by automated tests — anything touching
real audio hardware or a live WebRTC/OpenAI connection has to be verified by
actually running it against the hardware (see "Manual verification" below).

## Manual verification checklist

Automated tests can't prove the audio path or the live OpenAI connection work —
verify these by hand once, on the real device:

1. `python3 -m sounddevice` — confirm your device appears in both the input and
   output lists. ✅ Verified on urushi-room: `EMEET OfficeCore M0 Plus` at
   index 1, 1 input / 2 output channels.
2. `python3 scripts/audio_selftest.py --input-device 1 --output-device 1` — a
   real record/playback loopback through `sounddevice`, independent of
   WebRTC/aiortc. ✅ Verified on urushi-room: captured real signal (peak ~45%
   of full scale, not silence) at 16000Hz, played back correctly resampled at
   48000Hz.
3. `pip install -r requirements-dev.txt && pytest` on the device itself — same
   17 pure-logic tests as CI, just confirming they also pass on the target
   Python version. ✅ Verified on urushi-room (Python 3.13.5, aarch64).
4. A real session end-to-end: pair a device from the Ready screen, fill in
   `.env`, run `python3 main.py`, and have a short real conversation. ✅
   Partially verified on urushi-room: real WebRTC connection to OpenAI
   established, real graceful shutdown → real backend-generated summary all
   confirmed working. Calibration itself (a participant actually getting mapped
   to a diarization label) has NOT yet been verified live — the one attempt
   timed out due to the buffering bug above before it could be fixed. Worth a
   fresh run now that it's fixed.

## Known limitations / design decisions

- **Confirmed the hard way in a real session**: running this under `nohup
  python3 main.py > log.txt &` (any non-interactive/redirected invocation) used
  to silently swallow the calibration "please say hello" prompts until the
  process exited — Python block-buffers stdout when it isn't a TTY. `main.py`
  now forces line buffering explicitly (`sys.stdout.reconfigure(line_buffering=True)`)
  so this holds regardless of how it's launched; you no longer need to remember
  `python3 -u`.
- **Confirmed on a real EMEET OfficeCore M0 Plus**: its microphone only accepts
  16000Hz, its speaker only accepts 48000Hz — genuinely different rates per
  direction, not a typo, and `sounddevice`'s reported `default_samplerate`
  (48000 for both) was actively misleading — capture at 48000 fails outright.
  `URUSHI_INPUT_SAMPLE_RATE`/`URUSHI_OUTPUT_SAMPLE_RATE` are separate settings
  for exactly this reason; re-verify both with `scripts/audio_selftest.py`
  before trusting the defaults on different hardware. The mic's lower rate is
  fine for the WebRTC send path — Opus natively supports 16000Hz and aiortc
  resamples internally as needed.
- Calibration only runs once, on the first connection. If the client
  reconnects mid-session (network blip, etc.), the new Realtime session may
  assign different diarization labels — this is the same accepted behaviour as
  the browser client (see `roomPrompt.ts`: Urushi is designed to say "Sorry —
  was that X speaking?" rather than confidently misattribute a statement), not
  a Pi-specific gap.
- `END_SESSION` from the mediation controller is logged, not acted on
  automatically — ending the session is a deliberate operator action (Ctrl+C
  here), mirroring the browser's hold-to-confirm End Session control.
- Single audio device pair only in this version — no support yet for a second
  paired device on the same session.
