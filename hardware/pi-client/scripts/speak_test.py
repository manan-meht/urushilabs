#!/usr/bin/env python3
"""
Makes Urushi say one given line out loud, then exits.

Sits between audio_selftest.py (sounddevice only, no network) and a real
session: this exercises the ACTUAL playback path — Realtime API over WebRTC,
Opus decode, resample in SpeakerPlayback, out to the configured output device —
without needing a conversation to reach an intervention, and without recording
anything in the session transcript.

Written after discovering that Urushi had been speaking into the Pi's 3.5mm
headphone jack for an entire day of testing: URUSHI_OUTPUT_DEVICE was unset, so
sounddevice fell back to the ALSA default rather than the EMEET. Every decision
was correct and nothing was audible, and there was no quick way to tell those
apart. This is that quick way.

Usage:
    ./venv/bin/python scripts/speak_test.py "Hi, main Urushi hun."

Stop the main client first — it holds the audio device open.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from urushi_pi.api_client import UrushiApiClient
from urushi_pi.config import ConfigError, load_config
from urushi_pi.realtime_audio import RealtimeAudioSession

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("speak_test")

# Generous: covers token mint, ICE, and the model actually generating speech.
SPEECH_TIMEOUT_SECONDS = 45


async def run(line: str) -> int:
    try:
        config = load_config()
    except ConfigError as exc:
        logger.error(str(exc))
        return 1

    logger.info("Output device: %s", config.output_device or "(system default — suspicious!)")

    async with UrushiApiClient(config.api_base_url, config.session_id, config.device_token) as api:
        token = await api.mint_realtime_token()
        if token.demo or not token.client_secret:
            logger.error("Backend returned a demo response — need a real key server-side.")
            return 1

        started = asyncio.Event()
        finished = asyncio.Event()

        async def on_speaking_change(speaking: bool) -> None:
            if speaking:
                logger.info("Audio started — you should be hearing it NOW.")
                started.set()
            elif started.is_set():
                finished.set()

        audio = RealtimeAudioSession(
            token.client_secret,
            input_device=config.input_device,
            output_device=config.output_device,
            input_sample_rate=config.input_sample_rate,
            output_sample_rate=config.output_sample_rate,
            on_assistant_speaking_change=on_speaking_change,
        )

        await audio.connect()
        logger.info("Connected. Saying: %s", line)

        if not audio.trigger_assistant_response(line):
            logger.error("Data channel was not open — nothing was sent.")
            await audio.close()
            return 1

        try:
            await asyncio.wait_for(finished.wait(), timeout=SPEECH_TIMEOUT_SECONDS)
            logger.info("Finished speaking.")
            result = 0
        except asyncio.TimeoutError:
            # Distinguishes "the model never spoke" from "it spoke but you heard
            # nothing" — which is the whole point of this script.
            if started.is_set():
                logger.warning("Audio started but never finished within the timeout.")
            else:
                logger.error("The model never produced audio at all.")
            result = 1

        # close() drains playback itself now, so no fixed sleep here.
        #
        # "Finished" above means response.done — the model finished GENERATING,
        # which happens several times faster than real time, with the audio still
        # working its way out to the speaker. That gap is what truncated this
        # script's first run (reported success after 1s for a 4s sentence) and,
        # more importantly, truncated Urushi mid-intervention in real sessions.
        await audio.close()
        return result


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(asyncio.run(run(" ".join(sys.argv[1:]))))


if __name__ == "__main__":
    main()
