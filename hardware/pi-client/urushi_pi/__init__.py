"""
Urushi Raspberry Pi hardware client.

This package contains NO mediation intelligence — no prompts, no LISTEN/INTERVENE
logic, no independent conversation state. All of that lives server-side in the
Urushi backend (urushi-labs). This client only:

  - captures audio from a local microphone (the EMEET conference speakerphone)
  - holds a WebRTC session directly with OpenAI's Realtime API, exactly like the
    browser client does (src/lib/room/realtimeAudioProvider.ts)
  - forwards finalized transcript text to the Urushi backend's existing
    /api/room/sessions/[id]/intervene endpoint
  - plays back whatever audio OpenAI's Realtime API streams back when the backend
    decides Urushi should speak
  - handles reconnection/backoff

See hardware/pi-client/README.md for setup and the architecture this mirrors.
"""

__version__ = "0.1.0"
