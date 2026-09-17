#!/usr/bin/env python3
"""
Entry point for the Urushi Raspberry Pi hardware client.

    EMEET microphone
      -> this client (mic capture)
      -> OpenAI Realtime API (WebRTC — same connection the browser client uses)
      -> Urushi backend (/api/room/sessions/[id]/intervene — the actual mediation
         controller; this client only forwards transcript text and plays back
         whatever it's told to say)
      -> OpenAI Realtime API (speech synthesis, same connection)
      -> this client (speaker playback)
      -> EMEET speaker

Run: python3 main.py   (after `pip install -r requirements.txt` and filling in .env)
Stop: Ctrl+C — this ends the session cleanly and prints the final report.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import sys

from urushi_pi.api_client import UrushiApiClient
from urushi_pi.calibration import run_calibration
from urushi_pi.config import ConfigError, load_config
from urushi_pi.room_session import RoomSession

# Force line buffering on stdout regardless of how this process is invoked.
# Confirmed the hard way: run under `nohup ... > log.txt &` (not a TTY), Python's
# default stdout buffering is block-buffered, so calibration.py's "please say
# hello" prompts sat unflushed until process exit — the calibration timeouts
# passed with the prompt never actually visible in the log. `python3 -u` fixes
# this too, but only if you remember to pass it every time; this doesn't rely
# on that.
sys.stdout.reconfigure(line_buffering=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("urushi_pi.main")


async def run() -> None:
    try:
        config = load_config()
    except ConfigError as exc:
        logger.error(str(exc))
        sys.exit(1)

    async with UrushiApiClient(config.api_base_url, config.session_id, config.device_token) as api:
        session = RoomSession(
            api,
            input_device=config.input_device,
            output_device=config.output_device,
            input_sample_rate=config.input_sample_rate,
            output_sample_rate=config.output_sample_rate,
        )

        stop_requested = asyncio.Event()

        def request_stop() -> None:
            logger.info("Stopping...")
            stop_requested.set()

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, request_stop)

        audio = await session.connect()

        participants = await api.get_participants()
        uncalibrated = [p for p in participants if not p.speaker_label]
        if not session.supports_diarization:
            # Don't prompt people to say hello when the configured transcription
            # model can't report who spoke — the mapping it produces would be
            # meaningless, and waiting out a timeout per participant wastes real
            # time at the start of every session.
            logger.warning(
                "Speaker identification unavailable (transcription model isn't diarization-capable) — "
                "skipping calibration. Urushi will hear the room as a single voice."
            )
        elif uncalibrated:
            print(f"\n{len(uncalibrated)} participant(s) need speaker calibration.")
            await run_calibration(api, audio, uncalibrated, restore_handler=session.mediation_handler)
        else:
            logger.info("All participants already calibrated — skipping.")

        # Urushi speaks first — but that's run_forever()'s job, not ours. It
        # re-attempts the opening on every connection until audio actually
        # reaches the room, so a WebRTC drop in the first few seconds (which does
        # happen) doesn't leave the session silent forever.
        run_task = asyncio.ensure_future(session.run_forever())
        stop_task = asyncio.ensure_future(stop_requested.wait())

        done, pending = await asyncio.wait({run_task, stop_task}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()

        await session.stop()

        if not config.end_session_on_exit:
            # Development escape hatch. Completing a session is irreversible — it
            # generates the final report and locks the session to 'completed', so
            # the next client start needs a brand-new session paired from the
            # browser. That makes restarting the client to pick up a config change
            # unreasonably expensive while iterating.
            logger.info(
                "Exiting without ending the session (URUSHI_END_SESSION_ON_EXIT=false). "
                "The session stays live — restart this client to rejoin it."
            )
            return

        logger.info("Generating final summary...")
        try:
            result = await api.complete()
            report = result.get("report", {})
            print("\n" + "=" * 60)
            print("SESSION SUMMARY")
            print("=" * 60)
            print(report.get("whatHappened", "(no summary available)"))
            print("=" * 60 + "\n")
        except Exception:  # noqa: BLE001
            logger.exception("Failed to generate final summary — you can still view it in the browser.")


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
