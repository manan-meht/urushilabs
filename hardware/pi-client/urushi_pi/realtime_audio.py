"""
WebRTC session to OpenAI's Realtime API — the Python equivalent of
src/lib/room/realtimeAudioProvider.ts. Same signaling flow (SDP offer POSTed to
https://api.openai.com/v1/realtime/calls with the ephemeral client secret as
bearer auth, data channel named "oai-events"), same barge-in behaviour
(response.cancel sent the instant local speech is detected while Urushi is
talking). Hardware-dependent (aiortc) — the parsing/decision logic it calls into
lives in realtime_events.py and is separately unit-tested.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Awaitable, Callable

import aiohttp
from aiortc import RTCPeerConnection, RTCSessionDescription

from .audio_track import MicrophoneStreamTrack, SpeakerPlayback
from .realtime_events import (
    RealtimeError as RealtimeErrorEvent,
    ResponseEnded,
    ResponseStarted,
    SpeechStarted,
    TranscriptCompleted,
    parse_realtime_event,
)

logger = logging.getLogger(__name__)

REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls"
DATA_CHANNEL_OPEN_TIMEOUT_SECONDS = 15


class RealtimeAudioSession:
    """One live WebRTC connection to OpenAI's Realtime API. Construct a fresh
    instance per connection attempt — mirrors the browser client's pattern of a
    new RealtimeAudioProvider per start()/reconnect rather than reusing one."""

    def __init__(
        self,
        client_secret: str,
        *,
        input_device: str | int | None = None,
        output_device: str | int | None = None,
        # Separate rates on purpose — real USB conferencing hardware can (and, on
        # the EMEET OfficeCore M0 Plus, does) support different sample rates for
        # capture vs. playback. aiortc's Opus codec resamples the outgoing mic
        # track to whatever it needs internally, so a non-48000 input rate is
        # fine for the send path; the incoming/playback side is resampled
        # explicitly in audio_track.py's SpeakerPlayback to output_sample_rate.
        input_sample_rate: int = 16000,
        output_sample_rate: int = 48000,
        on_transcript: Callable[[str, str | None], Awaitable[None]] | None = None,
        on_assistant_speaking_change: Callable[[bool], Awaitable[None]] | None = None,
        on_closed: Callable[[str], Awaitable[None]] | None = None,
    ):
        self._client_secret = client_secret
        self._on_transcript = on_transcript
        self._on_assistant_speaking_change = on_assistant_speaking_change
        self._on_closed = on_closed

        self._pc = RTCPeerConnection()
        self._mic = MicrophoneStreamTrack(device=input_device, sample_rate=input_sample_rate)
        self._speaker = SpeakerPlayback(device=output_device, sample_rate=output_sample_rate)
        self._data_channel = None
        self._playback_task: asyncio.Task | None = None
        self._assistant_speaking = False
        #: True once Urushi has begun any response on this connection. Tells
        #: close() whether it is worth waiting for playback to start — the audio
        #: lags the data-channel events, so "no audio yet" does not mean "none
        #: coming". False keeps an ordinary silent reconnect instant.
        self._audio_expected = False
        self._connected = asyncio.Event()

    async def connect(self) -> None:
        self._pc.addTrack(self._mic)
        self._data_channel = self._pc.createDataChannel("oai-events")
        self._data_channel.on("message", self._handle_message)
        self._data_channel.on("open", lambda: self._connected.set())

        @self._pc.on("track")
        def on_track(track):  # noqa: ANN001
            if track.kind == "audio":
                self._playback_task = asyncio.ensure_future(self._speaker.run(track))

        @self._pc.on("connectionstatechange")
        async def on_state_change() -> None:
            logger.info("WebRTC connection state: %s", self._pc.connectionState)
            if self._pc.connectionState in ("failed", "closed", "disconnected") and self._on_closed:
                await self._on_closed(f"WebRTC connection {self._pc.connectionState}.")

        offer = await self._pc.createOffer()
        await self._pc.setLocalDescription(offer)

        async with aiohttp.ClientSession() as http:
            async with http.post(
                REALTIME_CALLS_URL,
                data=self._pc.localDescription.sdp,
                headers={
                    "Authorization": f"Bearer {self._client_secret}",
                    "Content-Type": "application/sdp",
                },
            ) as resp:
                if resp.status >= 400:
                    text = await resp.text()
                    raise RuntimeError(f"Realtime connection failed ({resp.status}): {text}")
                answer_sdp = await resp.text()

        await self._pc.setRemoteDescription(RTCSessionDescription(sdp=answer_sdp, type="answer"))
        self._mic.start()

        try:
            await asyncio.wait_for(self._connected.wait(), timeout=DATA_CHANNEL_OPEN_TIMEOUT_SECONDS)
        except asyncio.TimeoutError as exc:
            raise RuntimeError("Timed out waiting for the Realtime data channel to open.") from exc

    def set_transcript_handler(self, handler: Callable[[str, str | None], Awaitable[None]] | None) -> None:
        """Swaps the transcript callback at runtime — used by calibration.py to
        briefly intercept "say hello" utterances without them reaching the
        mediation controller, then hand control back to the normal handler."""
        self._on_transcript = handler

    def trigger_assistant_response(self, spoken_text: str) -> bool:
        """Manually asks Urushi to speak. The mediation controller decides when
        to call this — turn_detection.create_response is false server-side
        (src/lib/ai/realtime/config.ts), so the model never auto-replies.

        Returns whether the request actually went out. Callers that need to know
        the words reached the room (the session opening) must check this rather
        than assume; a closed data channel silently swallows the utterance."""
        if not self._data_channel or self._data_channel.readyState != "open":
            logger.warning("Cannot trigger assistant response — data channel not open.")
            return False
        self._data_channel.send(json.dumps({
            "type": "response.create",
            "response": {"instructions": f'Say this to the room, naturally, in your own voice: "{spoken_text}"'},
        }))
        return True

    def _cancel_assistant_response(self) -> None:
        if not self._assistant_speaking:
            return
        if not self._data_channel or self._data_channel.readyState != "open":
            return
        self._data_channel.send(json.dumps({"type": "response.cancel"}))

    def _handle_message(self, message: str) -> None:
        event = parse_realtime_event(message)

        if isinstance(event, SpeechStarted):
            self._cancel_assistant_response()
        elif isinstance(event, TranscriptCompleted):
            if self._on_transcript:
                asyncio.ensure_future(self._on_transcript(event.content, event.diarization_speaker_label))
        elif isinstance(event, ResponseStarted):
            self._assistant_speaking = True
            self._audio_expected = True
            if self._on_assistant_speaking_change:
                asyncio.ensure_future(self._on_assistant_speaking_change(True))
        elif isinstance(event, ResponseEnded):
            self._assistant_speaking = False
            if self._on_assistant_speaking_change:
                asyncio.ensure_future(self._on_assistant_speaking_change(False))
        elif isinstance(event, RealtimeErrorEvent):
            logger.error("Realtime API error: %s", event.message)

    async def close(self) -> None:
        # Let Urushi finish the sentence before tearing anything down. Cancelling
        # the playback task first truncates mid-word: frames still in flight from
        # the remote track never reach the output stream, so the stream's own
        # drain has nothing left to flush.
        #
        # Costs nothing when nobody is speaking — drain() returns immediately if
        # no audio has played, and within ~0.4s once playback has caught up.
        await self._speaker.drain(expect_audio=self._audio_expected)

        if self._playback_task:
            self._playback_task.cancel()
        self._mic.stop()
        self._speaker.close()
        await self._pc.close()
