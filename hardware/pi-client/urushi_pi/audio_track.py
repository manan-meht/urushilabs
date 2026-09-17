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
        except asyncio.CancelledError:
            pass
        except MediaStreamError:
            # Normal end-of-stream: aiortc raises this when the remote track ends
            # (connection closed / session over). Without catching it here the
            # task dies with an unretrieved exception and dumps a traceback on
            # every clean shutdown.
            logger.debug("Remote audio track ended.")

    def close(self) -> None:
        self._stream.stop()
        self._stream.close()
