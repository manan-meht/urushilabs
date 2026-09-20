"""
RoomSession — orchestrates the API client and the realtime audio session,
mirroring src/lib/room/roomSessionClient.ts. This is the seam between "what
OpenAI told us" and "what the Urushi backend told us to do" — it contains NO
mediation judgment of its own, only plumbing and reconnection handling.

connect() and run_forever() are deliberately separate: calibration (see
calibration.py) has to run on the SAME live connection that continues into
ongoing mediation — diarization labels are only meaningful within one Realtime
session, so reconnecting would invalidate them. main.py calls connect() once,
optionally runs calibration against the returned session, then calls
run_forever() to take over from there (reusing that connection for its first
cycle, opening fresh ones — uncalibrated, same as the browser client's own
accepted behaviour on reconnect — for any reconnects after that).
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Awaitable, Callable

from .api_client import UrushiApiClient
from .realtime_audio import RealtimeAudioSession
from .reconnect import get_reconnect_delay

logger = logging.getLogger(__name__)

#: How long the room must be quiet before Urushi is offered the turn. Short
#: enough to feel like conversation, long enough not to talk over someone
#: who is simply thinking.
PAUSE_THRESHOLD_SECONDS = 6.0
PAUSE_POLL_SECONDS = 1.5

TranscriptHandler = Callable[[str, str | None], Awaitable[None]]


class RoomSession:
    def __init__(
        self,
        api: UrushiApiClient,
        *,
        input_device: str | int | None = None,
        output_device: str | int | None = None,
        input_sample_rate: int = 16000,
        output_sample_rate: int = 48000,
    ):
        self._api = api
        self._input_device = input_device
        self._output_device = output_device
        self._input_sample_rate = input_sample_rate
        self._output_sample_rate = output_sample_rate
        self._audio: RealtimeAudioSession | None = None
        self._reconnect_attempt = 0
        self._stopping = False
        self._closed_event: asyncio.Event | None = None
        self._close_reason: str = ""
        self._mediation_handler: TranscriptHandler | None = None
        #: Set on connect() from the backend's reported transcription model.
        #: False until then — callers should only read it after connecting.
        self.supports_diarization: bool = False
        #: Opening-line state. Cached across reconnects so a drop mid-introduction
        #: retries the same words rather than paying to generate new ones, and so
        #: the backend is only told "delivered" once audio has actually started.
        self._opening_text: str | None = None
        self._opening_delivered = False
        self._opening_awaiting_audio = False
        #: Monotonic time of the last transcript or spoken turn. The pause
        #: watchdog measures quiet from here.
        self._last_activity: float = time.monotonic()
        self._pause_reported_at: float | None = None

    @property
    def mediation_handler(self) -> TranscriptHandler | None:
        """The normal (non-calibration) transcript handler — pass this to
        run_calibration()'s restore_handler so mediation resumes afterwards."""
        return self._mediation_handler

    async def connect(self) -> RealtimeAudioSession:
        """Opens one live WebRTC connection and wires the standard mediation
        transcript handler onto it. Returns the connected session so a caller
        can temporarily intercept its transcript handler (calibration) before
        mediation begins."""
        token = await self._api.mint_realtime_token()
        self.supports_diarization = token.supports_diarization
        if token.demo or not token.client_secret:
            raise RuntimeError(
                "Backend returned a demo/no-key response — the Pi client needs a real "
                "Realtime API connection. Set DEMO_MODE=false and a real OPENAI_API_KEY "
                "server-side, then restart this client."
            )

        self._closed_event = asyncio.Event()
        self._close_reason = ""
        # A pending opening from a connection that has since died is not pending
        # any more — it was never heard, and this new connection has to say it.
        self._opening_awaiting_audio = False

        async def on_transcript(content: str, diarization_label: str | None) -> None:
            # Logged before the decision, and for every utterance including the
            # ones Urushi sits out. LISTEN is the overwhelmingly common outcome,
            # so without this a healthy silent session and a dead microphone
            # produce byte-identical logs — which cost real debugging time.
            logger.info("Heard: %s", content)
            self._last_activity = time.monotonic()

            try:
                decision = await self._api.report_utterance(content, diarization_label)
            except Exception:  # noqa: BLE001
                logger.exception("Failed to report utterance to the backend")
                return

            # Someone spoke, so the quiet clock starts again from here.
            self._last_activity = time.monotonic()
            await self._handle_decision(decision)

        async def on_assistant_speaking_change(speaking: bool) -> None:
            logger.debug("Assistant speaking: %s", speaking)

        async def on_closed(reason: str) -> None:
            self._close_reason = reason
            assert self._closed_event is not None
            self._closed_event.set()

        self._mediation_handler = on_transcript

        self._audio = RealtimeAudioSession(
            token.client_secret,
            input_device=self._input_device,
            output_device=self._output_device,
            input_sample_rate=self._input_sample_rate,
            output_sample_rate=self._output_sample_rate,
            on_transcript=on_transcript,
            on_assistant_speaking_change=on_assistant_speaking_change,
            on_closed=on_closed,
        )

        await self._audio.connect()
        logger.info("Connected. Listening...")
        return self._audio

    async def deliver_opening(self) -> None:
        """Speaks Urushi's opening line, if this session still owes the room one.

        Safe to call on every connection: it's a no-op once delivered, and a
        no-op for a session that was already opened by an earlier run. Speaking
        first matters because Room Mode listens by default — with nothing said,
        the controller correctly finds nothing to mediate, which is
        indistinguishable from the device being broken.
        """
        if self._opening_delivered or not self._audio:
            return

        if self._opening_text is None:
            text = await self._api.fetch_opening()
            if text is None:
                # Already opened in a previous run, or generation failed. Either
                # way, stop asking on every reconnect.
                self._opening_delivered = True
                return
            self._opening_text = text

        logger.info("Opening: %s", self._opening_text)

        # Taken BEFORE triggering: anything audible at or before this instant
        # belongs to an earlier response, not to the opening.
        baseline = self._audio.last_audible_write

        if not self._audio.trigger_assistant_response(self._opening_text):
            logger.warning("Opening could not be sent — retrying on the next connection.")
            return

        self._opening_awaiting_audio = True
        asyncio.ensure_future(self._confirm_opening_once_heard(baseline))

    async def _confirm_opening_once_heard(self, baseline: float | None) -> None:
        """Mark the opening delivered, but only after the room has actually heard it.

        The obvious signal — response.started on the data channel — is wrong, and
        was wrong in production: it fires before the RTP audio arrives, so the
        backend recorded an introduction that nobody heard and then refused to
        offer another one. `baseline` is the last-audible timestamp taken before
        triggering, so audio from an earlier response cannot be mistaken for this
        one.
        """
        heard = await self._audio.wait_until_audible(after=baseline) if self._audio else False

        if not heard:
            # The connection likely died mid-introduction. Leave the opening
            # unclaimed so the next connection says it again.
            logger.warning("Opening never became audible — will retry on the next connection.")
            self._opening_awaiting_audio = False
            return

        self._opening_awaiting_audio = False
        self._opening_delivered = True
        if self._opening_text:
            await self._api.confirm_opening(self._opening_text)
            logger.info("Opening delivered and confirmed.")

    async def _handle_decision(self, decision) -> None:  # noqa: ANN001
        """Acts on one controller decision.

        Shared by the transcript path and the pause watchdog so the two cannot
        drift apart in how they speak, log, or reset the quiet clock.
        """
        if decision.action == "LISTEN":
            logger.info("Urushi [LISTEN] — %s", decision.reasoning)
            return

        logger.info("Urushi [%s]: %s", decision.action, decision.spoken_text)
        if decision.action == "END_SESSION":
            # Mirrors the browser's deliberate hold-to-confirm End Session control —
            # Urushi SUGGESTING the session is done doesn't end it automatically.
            logger.info("Urushi suggested ending the session. Press Ctrl+C to end and generate the summary.")

        if decision.spoken_text and self._audio:
            self._audio.trigger_assistant_response(decision.spoken_text)
            # Urushi speaking is activity too: the room should get a chance to
            # reply before it is offered the turn again.
            self._last_activity = time.monotonic()

    async def _watch_for_pauses(self) -> None:
        """Tells the backend when the room goes quiet.

        Transcripts only arrive when somebody finishes speaking, so without this
        a lull produces no event at all and a decision to stay quiet can never be
        revisited. Answering a question and then waiting — the ordinary way of
        handing someone the floor — left Urushi with nothing to react to, and the
        room sitting in silence.

        Reports a pause once per lull, not repeatedly: the point is to offer the
        turn, not to nag the backend every few seconds while people think.
        """
        while not self._stopping:
            await asyncio.sleep(PAUSE_POLL_SECONDS)

            if not self._audio or self._stopping:
                continue

            quiet_for = time.monotonic() - self._last_activity
            if quiet_for < PAUSE_THRESHOLD_SECONDS:
                continue
            # Already offered the turn for this lull.
            if self._pause_reported_at is not None and self._pause_reported_at >= self._last_activity:
                continue

            self._pause_reported_at = time.monotonic()
            asked_at = self._last_activity
            try:
                decision = await self._api.report_pause(quiet_for)
            except Exception:  # noqa: BLE001 - a failed poll must not kill the session
                logger.debug("Pause report failed", exc_info=True)
                continue

            # Somebody started talking while we were asking. The lull is over, so
            # the answer is stale — taking the turn now would mean speaking over
            # whoever just began. Observed live: a pause fired one second after a
            # transcript arrived, because the round trip takes a couple of
            # seconds and nothing re-checked afterwards.
            if self._last_activity != asked_at:
                logger.debug("Pause answer discarded — someone spoke while we were asking.")
                continue

            if decision.action != "LISTEN":
                logger.info("Pause after %.0fs — taking the turn.", quiet_for)
            await self._handle_decision(decision)

    async def wait_until_closed(self) -> str:
        """Blocks until the current connection ends, then returns the reason."""
        assert self._closed_event is not None, "connect() must be called first."
        await self._closed_event.wait()
        return self._close_reason

    async def run_forever(self) -> None:
        """Keeps a session alive: reuses an already-open connect()ed session for
        its first cycle, then reconnects (with backoff — see reconnect.py) for
        any drops after that, until stop() is called or attempts are exhausted."""
        pause_task: asyncio.Task | None = None

        while not self._stopping:
            try:
                if not self._audio:
                    await self.connect()
                self._reconnect_attempt = 0
                await self.deliver_opening()
                if pause_task is None or pause_task.done():
                    pause_task = asyncio.ensure_future(self._watch_for_pauses())
                reason = await self.wait_until_closed()
                if reason:
                    logger.warning("Session ended: %s", reason)
            except Exception as exc:  # noqa: BLE001 - top-level session loop must not die silently
                logger.warning("Realtime session error: %s", exc)
            finally:
                if self._audio:
                    await self._audio.close()
                self._audio = None

            if self._stopping:
                break

            delay = get_reconnect_delay(self._reconnect_attempt)
            if delay is None:
                logger.error("Reconnect attempts exhausted — check network/backend, then restart the client.")
                break
            self._reconnect_attempt += 1
            logger.info("Reconnecting in %.0fs (attempt %d)...", delay, self._reconnect_attempt)
            await asyncio.sleep(delay)

    async def stop(self) -> None:
        self._stopping = True
        if self._audio:
            await self._audio.close()
        if self._closed_event:
            self._closed_event.set()
