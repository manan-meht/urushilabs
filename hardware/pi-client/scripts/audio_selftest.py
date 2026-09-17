#!/usr/bin/env python3
"""
Standalone hardware sanity check — records a few seconds from the configured
input device and plays it back on the output device, using `sounddevice`
directly (no aiortc/av involved). Run this BEFORE attempting a real session:
it isolates "does sounddevice actually talk to the hardware" from "does the
WebRTC/OpenAI path work", so a problem in one doesn't get confused for the
other.

Input and output rates are deliberately independent — real USB conferencing
hardware can (and, on the EMEET OfficeCore M0 Plus, does) support different
sample rates for capture vs. playback; this script uses `sd.check_input/
output_settings` to fail fast with a clear message rather than a cryptic
PortAudio error if you pick one that isn't actually supported.

Usage:
    python3 scripts/audio_selftest.py --input-device 1 --output-device 1
"""

from __future__ import annotations

import argparse
import sys

import numpy as np
import sounddevice as sd

DEFAULT_INPUT_RATE = 16000
DEFAULT_OUTPUT_RATE = 48000


def resample_linear(samples: np.ndarray, from_rate: int, to_rate: int) -> np.ndarray:
    """Simple linear-interpolation resample — good enough for a smoke test
    (correct pitch/duration on playback), not audio-quality-critical."""
    if from_rate == to_rate:
        return samples
    duration = len(samples) / from_rate
    old_indices = np.arange(len(samples))
    new_length = int(duration * to_rate)
    new_indices = np.linspace(0, len(samples) - 1, new_length)
    return np.interp(new_indices, old_indices, samples).astype(np.int16)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-device", default=None, help="Name substring or index (default: system default)")
    parser.add_argument("--output-device", default=None, help="Name substring or index (default: system default)")
    parser.add_argument("--input-rate", type=int, default=DEFAULT_INPUT_RATE)
    parser.add_argument("--output-rate", type=int, default=DEFAULT_OUTPUT_RATE)
    parser.add_argument("--seconds", type=float, default=3.0)
    args = parser.parse_args()

    def parse_device(value: str | None) -> str | int | None:
        if value is not None and value.isdigit():
            return int(value)
        return value

    input_device = parse_device(args.input_device)
    output_device = parse_device(args.output_device)

    print("Available devices:")
    print(sd.query_devices())
    print()

    for label, check, device, rate in (
        ("input", sd.check_input_settings, input_device, args.input_rate),
        ("output", sd.check_output_settings, output_device, args.output_rate),
    ):
        try:
            check(device=device, samplerate=rate, channels=1)
            print(f"{label}: device={device!r} @ {rate}Hz — OK")
        except Exception as exc:  # noqa: BLE001
            print(f"{label}: device={device!r} @ {rate}Hz — FAILED: {exc}")
            print(f"Try other rates, e.g.: for r in (8000,16000,24000,32000,44100,48000): "
                  f"sd.check_{label}_settings(device={device!r}, samplerate=r, channels=1)")
            sys.exit(1)

    print(f"\nRecording {args.seconds}s from input_device={input_device!r} at {args.input_rate}Hz mono...")
    recording = sd.rec(
        int(args.seconds * args.input_rate),
        samplerate=args.input_rate,
        channels=1,
        dtype="int16",
        device=input_device,
    )
    sd.wait()

    peak = int(np.abs(recording).max())
    print(f"Captured {len(recording)} samples. Peak amplitude: {peak} / 32767")
    if peak < 50:
        print("WARNING: peak amplitude is very low — check the mic is unmuted and not too far away.")

    playback = resample_linear(recording.reshape(-1), args.input_rate, args.output_rate)

    print(f"Playing it back on output_device={output_device!r} at {args.output_rate}Hz...")
    sd.play(playback, samplerate=args.output_rate, device=output_device)
    sd.wait()
    print("Done. If you heard your own recording, capture + playback both work.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
