"""
Pure parsing/classification of OpenAI Realtime API data-channel events (the
"oai-events" channel). Mirrors the event handling in
src/lib/room/realtimeAudioProvider.ts's handleServerEvent — same event type
strings, same fields — just returning a typed Python value instead of invoking
callbacks directly, so this module has no aiortc dependency and is fully
unit-testable.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Union


@dataclass(frozen=True)
class SpeechStarted:
    """A participant started talking — the signal to barge in over Urushi if speaking."""


@dataclass(frozen=True)
class TranscriptCompleted:
    content: str
    diarization_speaker_label: str | None = None


@dataclass(frozen=True)
class ResponseStarted:
    pass


@dataclass(frozen=True)
class ResponseEnded:
    pass


@dataclass(frozen=True)
class RealtimeError:
    message: str


@dataclass(frozen=True)
class Unhandled:
    """Anything we don't act on — an unrecognised event type, or malformed JSON.
    Deliberately not an exception: one bad frame should never take down a live
    mediation session (same fail-open posture as the browser client)."""

    event_type: str | None


RealtimeEvent = Union[SpeechStarted, TranscriptCompleted, ResponseStarted, ResponseEnded, RealtimeError, Unhandled]


def parse_realtime_event(raw: str) -> RealtimeEvent:
    try:
        event = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return Unhandled(event_type=None)

    if not isinstance(event, dict):
        return Unhandled(event_type=None)

    event_type = event.get("type")

    if event_type == "input_audio_buffer.speech_started":
        return SpeechStarted()

    if event_type == "conversation.item.input_audio_transcription.completed":
        transcript = event.get("transcript")
        if not isinstance(transcript, str) or not transcript.strip():
            return Unhandled(event_type=event_type)
        speaker = event.get("speaker")
        return TranscriptCompleted(
            content=transcript,
            diarization_speaker_label=speaker if isinstance(speaker, str) else None,
        )

    if event_type == "response.created":
        return ResponseStarted()

    if event_type in ("response.done", "response.cancelled"):
        return ResponseEnded()

    if event_type == "error":
        message = event.get("message")
        return RealtimeError(message=message if isinstance(message, str) else "Realtime API error.")

    return Unhandled(event_type=event_type)
