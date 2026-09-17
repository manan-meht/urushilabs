"""
Configuration loaded from environment variables (.env). Pure — no I/O beyond
reading env vars — so it's importable and testable without aiortc/sounddevice
installed.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    # python-dotenv is a convenience, not a hard requirement — env vars can also
    # be exported directly (e.g. by a systemd unit's EnvironmentFile).
    pass


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Config:
    api_base_url: str
    session_id: str
    device_token: str
    input_device: str | None
    output_device: str | None
    # Deliberately separate rates, not one shared value: real USB audio hardware
    # (confirmed on the EMEET OfficeCore M0 Plus) can support different sample
    # rates for capture vs. playback — its mic only accepted 16000Hz, its speaker
    # only accepted 48000Hz, despite reporting a single "default" rate of 48000
    # that didn't actually work for input. Verify with scripts/audio_selftest.py
    # before trusting these defaults on different hardware.
    input_sample_rate: int
    output_sample_rate: int
    #: Whether exiting ends the mediation session (generating its final report).
    #: True matches real use — Ctrl+C means "we're done talking". Set false while
    #: developing so restarting the client doesn't burn the session, which is
    #: irreversible and forces re-pairing a new one from the browser.
    end_session_on_exit: bool


REQUIRED_VARS = ("URUSHI_API_BASE_URL", "URUSHI_SESSION_ID", "URUSHI_DEVICE_TOKEN")


def load_config(env: dict[str, str] | None = None) -> Config:
    """Reads and validates configuration. Raises ConfigError listing exactly
    what's missing — mirrors src/lib/env.ts's validateEnv() on the backend."""
    source = env if env is not None else os.environ

    missing = [name for name in REQUIRED_VARS if not source.get(name)]
    if missing:
        raise ConfigError(
            "Missing required environment variables: "
            + ", ".join(missing)
            + ". Copy .env.example to .env and fill them in — URUSHI_SESSION_ID and "
            "URUSHI_DEVICE_TOKEN come from the 'Pair a hardware device' panel on the "
            "Ready screen in the browser."
        )

    return Config(
        api_base_url=source["URUSHI_API_BASE_URL"].rstrip("/"),
        session_id=source["URUSHI_SESSION_ID"],
        device_token=source["URUSHI_DEVICE_TOKEN"],
        input_device=source.get("URUSHI_INPUT_DEVICE") or None,
        output_device=source.get("URUSHI_OUTPUT_DEVICE") or None,
        input_sample_rate=int(source.get("URUSHI_INPUT_SAMPLE_RATE", "16000")),
        output_sample_rate=int(source.get("URUSHI_OUTPUT_SAMPLE_RATE", "48000")),
        end_session_on_exit=source.get("URUSHI_END_SESSION_ON_EXIT", "true").strip().lower() != "false",
    )
