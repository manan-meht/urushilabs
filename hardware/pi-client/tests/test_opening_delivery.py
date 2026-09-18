"""
Tests for the opening-line delivery handshake in RoomSession.

Two production bugs are locked down here, both of the same shape — claiming the
opening was delivered when the room had not heard it:

1. It used to be claimed at GENERATION time, so a client that fetched one and
   then lost its connection before speaking had permanently consumed it. Every
   reconnect afterwards was told "already opened".
2. It was then claimed on response.started, which is a DATA CHANNEL event that
   fires before the RTP audio arrives. The transcript recorded an introduction
   nobody heard — observed live on 2026-09-18.

Only audible audio counts.

Skipped where aiortc isn't installed (developer laptops) — room_session imports
the hardware audio stack transitively. Runs on the Pi.
"""

from __future__ import annotations

import asyncio

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
    """Stands in for RealtimeAudioSession.

    `channel_open` False models a data channel that has already gone away.
    `becomes_audible` False models the connection dying between the send and any
    sound — the case that must NOT be recorded as delivered.
    """

    def __init__(self, channel_open: bool = True, becomes_audible: bool = True):
        self.channel_open = channel_open
        self.becomes_audible = becomes_audible
        self.spoken: list[str] = []
        self.last_audible_write: float | None = None
        self.waited_after: list[float | None] = []

    def trigger_assistant_response(self, spoken_text: str) -> bool:
        if not self.channel_open:
            return False
        self.spoken.append(spoken_text)
        return True

    async def wait_until_audible(self, *, after: float | None = None, timeout: float = 15.0) -> bool:
        self.waited_after.append(after)
        return self.becomes_audible


def make_session(api: FakeApi, audio: FakeAudio | None) -> RoomSession:
    session = RoomSession(api)  # type: ignore[arg-type]
    session._audio = audio  # type: ignore[assignment]
    return session


async def settle() -> None:
    """Let the fire-and-forget confirmation task run."""
    await asyncio.sleep(0)
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_confirms_only_once_the_room_has_heard_it():
    api = FakeApi()
    audio = FakeAudio()
    session = make_session(api, audio)

    await session.deliver_opening()
    assert audio.spoken == ["Hello, I'm Urushi."]

    await settle()
    assert api.confirmed == ["Hello, I'm Urushi."]


@pytest.mark.asyncio
async def test_does_not_confirm_when_audio_never_arrives():
    """The regression. response.started is not delivery — if no sound follows,
    the opening stays unclaimed so the next connection says it again."""
    api = FakeApi()
    audio = FakeAudio(becomes_audible=False)
    session = make_session(api, audio)

    await session.deliver_opening()
    await settle()

    assert audio.spoken == ["Hello, I'm Urushi."]
    assert api.confirmed == [], "must not claim an opening the room never heard"
    assert session._opening_delivered is False

    # A later connection retries the same words rather than generating new ones.
    working = FakeAudio()
    session._audio = working  # type: ignore[assignment]
    await session.deliver_opening()
    await settle()

    assert working.spoken == ["Hello, I'm Urushi."]
    assert api.fetch_calls == 1
    assert api.confirmed == ["Hello, I'm Urushi."]


@pytest.mark.asyncio
async def test_ignores_audio_from_an_earlier_response():
    """The baseline is taken before triggering, so a previous response's audio
    cannot be mistaken for the opening's."""
    api = FakeApi()
    audio = FakeAudio()
    audio.last_audible_write = 123.0  # Urushi already spoke once on this connection
    session = make_session(api, audio)

    await session.deliver_opening()
    await settle()

    assert audio.waited_after == [123.0]


@pytest.mark.asyncio
async def test_does_not_reopen_once_delivered():
    api = FakeApi()
    audio = FakeAudio()
    session = make_session(api, audio)

    await session.deliver_opening()
    await settle()
    await session.deliver_opening()  # a later reconnect
    await settle()

    assert audio.spoken == ["Hello, I'm Urushi."]
    assert api.fetch_calls == 1
    assert api.confirmed == ["Hello, I'm Urushi."]


@pytest.mark.asyncio
async def test_retries_when_the_channel_was_already_closed():
    api = FakeApi()
    closed = FakeAudio(channel_open=False)
    session = make_session(api, closed)

    await session.deliver_opening()
    await settle()

    assert closed.spoken == []
    assert session._opening_delivered is False
    assert api.confirmed == []

    working = FakeAudio()
    session._audio = working  # type: ignore[assignment]
    await session.deliver_opening()
    await settle()
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
