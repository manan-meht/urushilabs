import json

from urushi_pi.realtime_events import (
    RealtimeError,
    ResponseEnded,
    ResponseStarted,
    SpeechStarted,
    TranscriptCompleted,
    Unhandled,
    parse_realtime_event,
)


def test_parses_speech_started():
    event = parse_realtime_event(json.dumps({"type": "input_audio_buffer.speech_started"}))
    assert isinstance(event, SpeechStarted)


def test_parses_transcript_completed_with_speaker_label():
    raw = json.dumps({
        "type": "conversation.item.input_audio_transcription.completed",
        "transcript": "I feel like I'm carrying most of the work.",
        "speaker": "A",
    })
    event = parse_realtime_event(raw)
    assert isinstance(event, TranscriptCompleted)
    assert event.content == "I feel like I'm carrying most of the work."
    assert event.diarization_speaker_label == "A"


def test_transcript_completed_without_speaker_label():
    raw = json.dumps({
        "type": "conversation.item.input_audio_transcription.completed",
        "transcript": "Hello.",
    })
    event = parse_realtime_event(raw)
    assert isinstance(event, TranscriptCompleted)
    assert event.diarization_speaker_label is None


def test_ignores_empty_transcript():
    raw = json.dumps({
        "type": "conversation.item.input_audio_transcription.completed",
        "transcript": "   ",
    })
    event = parse_realtime_event(raw)
    assert isinstance(event, Unhandled)


def test_parses_response_started_and_ended():
    assert isinstance(parse_realtime_event(json.dumps({"type": "response.created"})), ResponseStarted)
    assert isinstance(parse_realtime_event(json.dumps({"type": "response.done"})), ResponseEnded)
    assert isinstance(parse_realtime_event(json.dumps({"type": "response.cancelled"})), ResponseEnded)


def test_parses_error_event():
    event = parse_realtime_event(json.dumps({"type": "error", "message": "boom"}))
    assert isinstance(event, RealtimeError)
    assert event.message == "boom"


def test_error_event_without_message_gets_a_default():
    event = parse_realtime_event(json.dumps({"type": "error"}))
    assert isinstance(event, RealtimeError)
    assert event.message == "Realtime API error."


def test_unrecognised_event_type_is_unhandled_not_an_error():
    event = parse_realtime_event(json.dumps({"type": "some.future.event"}))
    assert isinstance(event, Unhandled)
    assert event.event_type == "some.future.event"


def test_malformed_json_never_raises():
    event = parse_realtime_event("{not valid json")
    assert isinstance(event, Unhandled)


def test_non_object_json_never_raises():
    event = parse_realtime_event(json.dumps(["not", "a", "dict"]))
    assert isinstance(event, Unhandled)
