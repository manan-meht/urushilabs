"""
Pure reconnection-backoff logic — a direct port of
src/lib/room/sessionLifecycle.ts's getReconnectDelay. Kept separate from the
actual WebRTC/network code so it's trivially unit-testable.
"""

from __future__ import annotations

RECONNECT_DELAYS_SECONDS: tuple[float, ...] = (1.0, 3.0, 8.0)


def get_reconnect_delay(attempt: int) -> float | None:
    """Returns the delay before the next reconnect attempt, or None once attempts
    are exhausted (caller should give up and surface an error)."""
    if attempt < 0 or attempt >= len(RECONNECT_DELAYS_SECONDS):
        return None
    return RECONNECT_DELAYS_SECONDS[attempt]
