"""
Thin REST client for the Urushi backend's device-facing Room Mode endpoints.
Mirrors src/lib/room/roomSessionClient.ts's fetch calls — same routes, same JSON
shapes, same Authorization: Bearer header — just from Python. No mediation logic
lives here; this module only moves bytes to/from the backend that owns the
actual intelligence.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)


class UrushiApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"Urushi API error {status}: {message}")
        self.status = status


@dataclass(frozen=True)
class RealtimeTokenResult:
    demo: bool
    client_secret: str | None
    model: str | None
    voice: str | None
    #: The transcription model the session was configured with. Only diarization-
    #: capable models report per-speaker labels, so this decides upfront whether
    #: speaker calibration is even possible (see supports_diarization).
    transcribe_model: str | None = None

    @property
    def supports_diarization(self) -> bool:
        return bool(self.transcribe_model and "diarize" in self.transcribe_model)


@dataclass(frozen=True)
class InterventionDecision:
    action: str
    reasoning: str
    spoken_text: str | None
    current_issue_title: str | None
    emerging_agreement: str | None


@dataclass(frozen=True)
class Participant:
    id: str
    name: str
    participant_index: int
    speaker_label: str | None


class UrushiApiClient:
    """One instance per session; not thread-safe. Use `async with` so the
    underlying aiohttp session is always closed."""

    def __init__(self, base_url: str, session_id: str, device_token: str):
        self._base = base_url.rstrip("/")
        self._session_id = session_id
        self._headers = {"Authorization": f"Bearer {device_token}"}
        self._http: aiohttp.ClientSession | None = None

    async def __aenter__(self) -> "UrushiApiClient":
        self._http = aiohttp.ClientSession(headers=self._headers)
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._http:
            await self._http.close()

    def _url(self, path: str) -> str:
        return f"{self._base}/api/room/sessions/{self._session_id}{path}"

    async def _post(self, path: str, json: dict | None = None) -> dict:
        assert self._http is not None, "Use 'async with UrushiApiClient(...)' before making requests."

        # One retry, for transport failures only. A pooled keep-alive connection
        # can be closed by the server between requests (a dev server reloading, a
        # proxy timing out an idle socket), and aiohttp surfaces that as
        # ServerDisconnectedError on the next use — nothing was processed, so
        # resending is safe.
        #
        # Not cosmetic: this was observed dropping the one utterance that mattered
        # most, a participant asking Urushi directly to speak. They get silence
        # and conclude the device is broken.
        #
        # Deliberately NOT retried: UrushiApiError. A 4xx/5xx means the request
        # was received and rejected, and replaying it could double-record an
        # utterance.
        for attempt in (1, 2):
            try:
                async with self._http.post(self._url(path), json=json or {}) as resp:
                    data = await resp.json()
                    if resp.status >= 400:
                        raise UrushiApiError(resp.status, data.get("error", "Unknown error"))
                    return data
            except (aiohttp.ServerDisconnectedError, aiohttp.ClientConnectionError):
                if attempt == 2:
                    raise
                logger.warning("Connection to the backend dropped on %s — retrying once.", path)

        raise AssertionError("unreachable")

    async def _get(self, path: str) -> dict:
        assert self._http is not None, "Use 'async with UrushiApiClient(...)' before making requests."
        async with self._http.get(self._url(path)) as resp:
            data = await resp.json()
            if resp.status >= 400:
                raise UrushiApiError(resp.status, data.get("error", "Unknown error"))
            return data

    async def mint_realtime_token(self) -> RealtimeTokenResult:
        data = await self._post("/realtime-token")
        return RealtimeTokenResult(
            demo=bool(data.get("demo")),
            client_secret=data.get("clientSecret"),
            model=data.get("model"),
            voice=data.get("voice"),
            transcribe_model=data.get("transcribeModel"),
        )

    async def get_participants(self) -> list[Participant]:
        data = await self._get("/participants")
        return [
            Participant(
                id=p["id"],
                name=p["name"],
                participant_index=p["participantIndex"],
                speaker_label=p.get("speakerLabel"),
            )
            for p in data.get("participants", [])
        ]

    async def calibrate_participant(
        self, participant_id: str, diarization_label: str, confidence: float | None = None
    ) -> None:
        payload: dict = {"diarizationLabel": diarization_label}
        if confidence is not None:
            payload["confidence"] = confidence
        await self._post(f"/participants/{participant_id}/calibrate", payload)

    async def report_utterance(
        self,
        content: str,
        diarization_speaker_label: str | None = None,
        speaker_confidence: float | None = None,
    ) -> InterventionDecision:
        payload: dict = {"content": content}
        if diarization_speaker_label is not None:
            payload["diarizationSpeakerLabel"] = diarization_speaker_label
        if speaker_confidence is not None:
            payload["speakerConfidence"] = speaker_confidence

        data = await self._post("/intervene", payload)
        decision = data["decision"]
        return InterventionDecision(
            action=decision["action"],
            reasoning=decision["reasoning"],
            spoken_text=decision.get("spokenText"),
            current_issue_title=decision.get("currentIssueTitle"),
            emerging_agreement=decision.get("emergingAgreement"),
        )

    async def pause(self) -> None:
        await self._post("/pause")

    async def resume(self) -> None:
        await self._post("/resume")

    async def fetch_opening(self) -> str | None:
        """Urushi's opening line for a session that's just gone live. Returns None
        if it has already opened (reconnects shouldn't make it introduce itself
        again) or if generating it failed — an opening is nice to have, never a
        reason to block the session from starting.

        Fetching does NOT claim the opening. Call confirm_opening() once the words
        have actually been spoken; until then the backend will keep handing one
        out, so a connection that dies mid-introduction costs nothing."""
        try:
            data = await self._post("/opening")
        except UrushiApiError:
            logger.warning("Could not fetch Urushi's opening line — continuing without it.", exc_info=True)
            return None
        if data.get("alreadyOpened"):
            return None
        text = data.get("spokenText")
        return text if isinstance(text, str) and text.strip() else None

    async def confirm_opening(self, spoken_text: str) -> None:
        """Marks the opening as delivered, recording it as the session's first
        assistant turn. Failing here is not fatal — worst case Urushi opens twice
        on a later reconnect, which is far better than never opening at all."""
        try:
            await self._post("/opening/delivered", {"spokenText": spoken_text})
        except UrushiApiError:
            logger.warning("Could not record Urushi's opening as delivered.", exc_info=True)

    async def complete(self) -> dict:
        return await self._post("/complete")

    async def get_status(self) -> dict:
        return await self._get("/status")
