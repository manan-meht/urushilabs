"""
Speaker calibration — the console-driven equivalent of LiveRoomView.tsx's
"Manan, please say hello — then tap below" step. No screen/touch on the Pi, so
this drives the same flow through the terminal (or systemd journal) instead: it
prints who should speak next, waits for a diarization-labelled transcript event
from the live Realtime session, and confirms it back to the operator before
moving on. Deliberately probabilistic — same as the browser flow, no biometric
voice profile is stored, only the label mapping for this session.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable

from .api_client import Participant, UrushiApiClient
from .realtime_audio import RealtimeAudioSession

logger = logging.getLogger(__name__)

TranscriptHandler = Callable[[str, str | None], Awaitable[None]]


async def run_calibration(
    api: UrushiApiClient,
    audio: RealtimeAudioSession,
    participants: list[Participant],
    *,
    restore_handler: TranscriptHandler | None,
    timeout_seconds: float = 20.0,
) -> None:
    """Prompts each participant in turn to say hello, and maps whichever
    diarization label the Realtime API reports back to that participant. Skips
    (with a warning) a participant no speech is detected for within the timeout
    rather than blocking the whole session on a calibration hiccup."""

    for participant in participants:
        print(f"\n{participant.name}, please say hello now...")

        # Two outcomes worth distinguishing: a labelled transcript (calibration
        # works), or a transcript with no label at all (the transcription model
        # isn't diarization-capable, so calibration can never work and there's no
        # point burning the timeout on every remaining participant).
        result: asyncio.Future[str | None] = asyncio.get_event_loop().create_future()

        async def capture(content: str, diarization_label: str | None, _fut=result) -> None:
            if not _fut.done():
                _fut.set_result(diarization_label)

        # Temporarily swap in a capture-only transcript handler for this one
        # utterance, then restore the session's normal handler afterwards —
        # calibration small talk should never reach the mediation controller.
        audio.set_transcript_handler(capture)

        try:
            label = await asyncio.wait_for(result, timeout=timeout_seconds)
        except asyncio.TimeoutError:
            logger.warning(
                "Nothing heard for %s within %.0fs — skipping. (Check the mic if this repeats.)",
                participant.name,
                timeout_seconds,
            )
            continue
        finally:
            audio.set_transcript_handler(restore_handler)

        if label is None:
            # Heard them fine, but the transcript carried no speaker label. That's
            # a property of the configured transcription model, not of this
            # participant — so stop here rather than repeating the prompt for
            # everyone else and implying they did something wrong.
            logger.warning(
                "Speech was heard, but this transcription model doesn't report speaker labels, "
                "so participants can't be told apart. Continuing without speaker identification — "
                "Urushi will hear the room as a single voice. "
                "(Set OPENAI_REALTIME_TRANSCRIBE_MODEL to a diarization-capable model, e.g. "
                "gpt-4o-transcribe-diarize, on an account that has access to it.)"
            )
            print("\nSkipping calibration — speaker identification isn't available.\n")
            return

        await api.calibrate_participant(participant.id, label)
        print(f"Thanks, {participant.name} — mapped to speaker {label}.")

    print("\nCalibration complete.\n")
