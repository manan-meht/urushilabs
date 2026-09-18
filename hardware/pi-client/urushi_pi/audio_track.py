"""
Local audio I/O for the EMEET conference speakerphone (or any ALSA-visible
input/output device): a custom aiortc MediaStreamTrack that reads mic frames via
sounddevice, and a playback helper that writes received remote audio frames
back out to the speaker.

Hardware-dependent — requires aiortc, av (PyAV) and sounddevice. Nothing in this
file is reachable from the pure-logic modules or their tests.
"""

from __future__ import annotations

import asyncio
import fractions
import logging
import time

import numpy as np
import sounddevice as sd
from aiortc import MediaStreamTrack
from aiortc.mediastreams import MediaStreamError
from av import AudioFrame
from av.audio.resampler import AudioResampler

logger = logging.getLogger(__name__)

SAMPLE_RATE = 48000  # WebRTC's standard audio sample rate
CHANNELS = 1
FRAME_MS = 20  # standard WebRTC frame size
#: Peak int16 amplitude below which a frame counts as silence. Comfort noise
#: and room tone sit far below this; speech sits far above it.
SILENCE_THRESHOLD = 500


class MicrophoneStreamTrack(MediaStreamTrack):
    """Captures mono PCM16 audio from the given input device and hands it to
    aiortc as ~20ms frames; aiortc/PyAV handle Opus encoding from there."""

    kind = "audio"

    def __init__(self, device: str | int | None = None, sample_rate: int = SAMPLE_RATE):
        super().__init__()
        self._sample_rate = sample_rate
        self._samples_per_frame = sample_rate * FRAME_MS // 1000
        self._queue: asyncio.Queue[np.ndarray] = asyncio.Queue(maxsize=50)
        self._timestamp = 0
        self._loop = asyncio.get_event_loop()

        def _callback(indata: np.ndarray, frames: int, time_info, status) -> None:  # noqa: ANN001
            if status:
                logger.warning("Mic input status: %s", status)
            mono = indata[:, 0].copy()
            # sounddevice's callback runs on its own audio thread — hand off to the
            # asyncio loop rather than touching the queue directly from there.
            self._loop.call_soon_threadsafe(self._enqueue, mono)

        self._stream = sd.InputStream(
            device=device,
            channels=CHANNELS,
            samplerate=sample_rate,
            blocksize=self._samples_per_frame,
            dtype="int16",
            callback=_callback,
        )

    def _enqueue(self, mono: np.ndarray) -> None:
        try:
            self._queue.put_nowait(mono)
        except asyncio.QueueFull:
            # Drop the oldest frame rather than blocking — a live mediation session
            # should never accumulate unbounded audio latency.
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            self._queue.put_nowait(mono)

    def start(self) -> None:
        self._stream.start()

    async def recv(self) -> AudioFrame:
        samples = await self._queue.get()
        frame = AudioFrame(format="s16", layout="mono", samples=len(samples))
        frame.sample_rate = self._sample_rate
        for plane in frame.planes:
            plane.update(samples.tobytes())
        frame.pts = self._timestamp
        frame.time_base = fractions.Fraction(1, self._sample_rate)
        self._timestamp += len(samples)
        return frame

    def stop(self) -> None:
        super().stop()
        self._stream.stop()
        self._stream.close()


class SpeakerPlayback:
    """Plays a remote aiortc audio track out to the given output device. Run via
    `await playback.run(track)` inside an asyncio task; cancel that task to stop.

    Uses PyAV's AudioResampler to force whatever format/rate the received track
    negotiated into mono s16 at our target sample rate — this is the same
    approach aiortc's own examples use, and avoids guessing at a received
    frame's channel layout by hand.
    """

    def __init__(self, device: str | int | None = None, sample_rate: int = SAMPLE_RATE):
        self._resampler = AudioResampler(format="s16", layout="mono", rate=sample_rate)
        self._stream = sd.OutputStream(device=device, channels=CHANNELS, samplerate=sample_rate, dtype="int16")
        self._stream.start()
        #: Monotonic time we last wrote audio that was actually audible, or None
        #: if nothing has ever played. Used by drain() to tell "Urushi is still
        #: talking" from "the track is idling".
        self._last_audible_write: float | None = None

    async def run(self, track: MediaStreamTrack) -> None:
        try:
            while True:
                frame = await track.recv()
                resampled = self._resampler.resample(frame)
                # PyAV versions differ on whether resample() returns a single
                # frame or a list of frames — normalize to a list either way.
                frames = resampled if isinstance(resampled, list) else [resampled]
                for f in frames:
                    pcm = f.to_ndarray().reshape(-1).astype(np.int16)
                    self._stream.write(pcm)
                    if pcm.size and int(np.abs(pcm.astype(np.int32)).max()) > SILENCE_THRESHOLD:
                        self._last_audible_write = time.monotonic()
        except asyncio.CancelledError:
            pass
        except MediaStreamError:
            # Normal end-of-stream: aiortc raises this when the remote track ends
            # (connection closed / session over). Without catching it here the
            # task dies with an unretrieved exception and dumps a traceback on
            # every clean shutdown.
            logger.debug("Remote audio track ended.")

    @property
    def last_audible_write(self) -> float | None:
        """Monotonic time audible audio was last written, or None if none ever
        has. Callers wanting "did the room actually hear this?" must compare
        against a baseline taken before triggering — see wait_until_audible."""
        return self._last_audible_write

    async def wait_until_audible(self, *, after: float | None = None, timeout: float = 15.0) -> bool:
        """Block until audible audio is written, returning whether it was.

        `after` is a baseline from last_audible_write taken BEFORE the thing you
        are waiting on; anything at or before it is somebody else's audio and
        does not count.

        This is the only honest answer to "has the room heard it?". The Realtime
        API's response.started arrives over the data channel well before the RTP
        audio does, so treating that event as delivery records speech that nobody
        heard — which is exactly what happened to the session opening.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            latest = self._last_audible_write
            if latest is not None and (after is None or latest > after):
                return True
            await asyncio.sleep(0.05)
        return False

    async def drain(
        self,
        *,
        expect_audio: bool = False,
        idle_seconds: float = 0.6,
        start_timeout: float = 5.0,
        timeout: float = 20.0,
    ) -> None:
        """Wait until Urushi has actually finished talking, up to `timeout`.

        Tearing down the moment a response ends truncates mid-sentence, because
        the Realtime API's data-channel events run well AHEAD of the audio. RTP
        arrives paced in real time, so `response.done` can fire before the first
        word is even audible — measured: at teardown, nothing had played at all.
        In a live session that means Urushi gets cut off part-way through an
        intervention, with no clue why.

        Two phases, because neither alone is sufficient:

        1. Wait for audio to BEGIN (`expect_audio`), since at close time it
           frequently has not. Skipped otherwise, so an ordinary reconnect with
           nobody speaking costs nothing.
        2. Wait for it to go quiet. Frame arrival is useless as a signal here — a
           WebRTC track streams continuously, pushing comfort noise between
           utterances, so waiting for frames to stop waits forever (measured: the
           full timeout). Audible frames are the signal.
        """
        deadline = time.monotonic() + timeout

        if expect_audio and self._last_audible_write is None:
            start_deadline = min(time.monotonic() + start_timeout, deadline)
            while self._last_audible_write is None and time.monotonic() < start_deadline:
                await asyncio.sleep(0.1)

        if self._last_audible_write is None:
            return  # nothing played, and nothing is going to

        while time.monotonic() < deadline:
            if time.monotonic() - self._last_audible_write >= idle_seconds:
                return
            await asyncio.sleep(0.1)

        logger.warning("Playback did not go idle within %.0fs — closing anyway.", timeout)

    def close(self) -> None:
        # stop() (unlike abort()) waits for buffers already handed to PortAudio.
        self._stream.stop()
        self._stream.close()
