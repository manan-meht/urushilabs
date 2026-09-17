"""
Tests for the opening-line delivery handshake in RoomSession.

The bug these lock down: the opening used to be claimed the moment it was
generated, so a client that fetched one and then lost its WebRTC connection
before speaking had permanently consumed it. Every reconnect afterwards was told
"already opened", the room sat in silence, and the transcript claimed Urushi had
introduced itself to people who never heard a word.

Skipped where aiortc isn't installed (developer laptops) — room_session imports
the hardware audio stack transitively. Runs on the Pi.
"""

from __future__ import annotations

import pytest

pytest.importorskip("aiortc", reason="hardware audio stack not installed here")

from urushi_pi.room_session import RoomSession  # noqa: E402


class FakeApi:
    def __init__(self, opening: str | None = "Hello, I'm Urushi."):
        self._opening = opening
        self.fetch_calls = 0
        self.confirmed: list[str] = []

    async def fetch_opening(self) -> str | None:
        self.fetch_calls += 1
        return self._opening

    async def confirm_opening(self, spoken_text: str) -> None:
        self.confirmed.append(spoken_text)


class FakeAudio:
    """Stands in for RealtimeAudioSession. `channel_open` False models a data
    channel that has already gone away — trigger_assistant_response reports the
    failure rather than silently swallowing the utterance."""

    def __init__(self, channel_open: bool = True):
        self.channel_open = channel_open
        self.spoken: list[str] = []

    def trigger_assistant_response(self, spoken_text: str) -> bool:
        if not self.channel_open:
            return False
        self.spoken.append(spoken_text)
        return True


def make_session(api: FakeApi, audio: FakeAudio | None) -> RoomSession:
    session = RoomSession(api)  # type: ignore[arg-type]
    session._audio = audio  # type: ignore[assignment]
    return session


@pytest.mark.asyncio
async def test_speaks_the_opening_then_confirms_only_once_audio_starts():
    api = FakeApi()
    audio = FakeAudio()
    session = make_session(api, audio)

    await session.deliver_opening()
    assert audio.spoken == ["Hello, I'm Urushi."]
    # Sent, but nothing has come out of the speaker yet — the backend must not
    # have been told the room was greeted.
    assert api.confirmed == []

    await session._note_assistant_audio_started()
    assert api.confirmed == ["Hello, I'm Urushi."]


@pytest.mark.asyncio
async def test_does_not_reopen_once_delivered():
    api = FakeApi()
    audio = FakeAudio()
    session = make_session(api, audio)

    await session.deliver_opening()
    await session._note_assistant_audio_started()
    await session.deliver_opening()  # a later reconnect

    assert audio.spoken == ["Hello, I'm Urushi."]
    assert api.fetch_calls == 1


@pytest.mark.asyncio
async def test_retries_the_same_words_when_the_connection_died_before_audio():
    """The regression. Send succeeds, connection dies before any sound, and the
    next connection has to say it — without paying to generate a new line."""
    api = FakeApi()
    first = FakeAudio()
    session = make_session(api, first)

    await session.deliver_opening()
    assert first.spoken == ["Hello, I'm Urushi."]
    assert api.confirmed == []

    # Connection drops. connect() clears the pending flag; a fresh audio session
    # takes over.
    session._opening_awaiting_audio = False
    second = FakeAudio()
    session._audio = second  # type: ignore[assignment]

    await session.deliver_opening()
    assert second.spoken == ["Hello, I'm Urushi."]
    assert api.fetch_calls == 1, "should reuse the cached line, not generate another"

    await session._note_assistant_audio_started()
    assert api.confirmed == ["Hello, I'm Urushi."]


@pytest.mark.asyncio
async def test_retries_when_the_channel_was_already_closed():
    api = FakeApi()
    closed = FakeAudio(channel_open=False)
    session = make_session(api, closed)

    await session.deliver_opening()
    assert closed.spoken == []
    assert session._opening_awaiting_audio is False
    assert session._opening_delivered is False

    working = FakeAudio()
    session._audio = working  # type: ignore[assignment]
    await session.deliver_opening()
    assert working.spoken == ["Hello, I'm Urushi."]


@pytest.mark.asyncio
async def test_stops_asking_when_the_session_was_opened_by_an_earlier_run():
    api = FakeApi(opening=None)
    audio = FakeAudio()
    session = make_session(api, audio)

    await session.deliver_opening()
    await session.deliver_opening()

    assert audio.spoken == []
    assert api.fetch_calls == 1, "a None reply means stop asking, not ask every reconnect"


@pytest.mark.asyncio
async def test_assistant_audio_from_a_normal_intervention_confirms_nothing():
    """on_assistant_speaking_change fires for every response Urushi gives, not
    just the opening. Without the pending guard, the first intervention in an
    already-opened session would post a bogus opening confirmation."""
    api = FakeApi()
    session = make_session(api, FakeAudio())

    await session._note_assistant_audio_started()
    assert api.confirmed == []
