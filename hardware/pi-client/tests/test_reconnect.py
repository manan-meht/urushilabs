from urushi_pi.reconnect import RECONNECT_DELAYS_SECONDS, get_reconnect_delay


def test_returns_increasing_delays_for_each_attempt():
    assert get_reconnect_delay(0) == RECONNECT_DELAYS_SECONDS[0]
    assert get_reconnect_delay(1) == RECONNECT_DELAYS_SECONDS[1]
    assert get_reconnect_delay(2) == RECONNECT_DELAYS_SECONDS[2]


def test_returns_none_once_attempts_are_exhausted():
    assert get_reconnect_delay(len(RECONNECT_DELAYS_SECONDS)) is None
    assert get_reconnect_delay(99) is None


def test_returns_none_for_a_negative_attempt():
    assert get_reconnect_delay(-1) is None
