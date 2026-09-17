import pytest

from urushi_pi.config import ConfigError, load_config


def test_loads_a_complete_config():
    env = {
        "URUSHI_API_BASE_URL": "http://192.168.1.197:3010/",
        "URUSHI_SESSION_ID": "session-1",
        "URUSHI_DEVICE_TOKEN": "token-abc",
    }
    config = load_config(env)
    assert config.api_base_url == "http://192.168.1.197:3010"  # trailing slash stripped
    assert config.session_id == "session-1"
    assert config.device_token == "token-abc"
    assert config.input_sample_rate == 16000
    assert config.output_sample_rate == 48000
    assert config.input_device is None
    assert config.output_device is None


def test_raises_listing_all_missing_vars():
    with pytest.raises(ConfigError) as exc_info:
        load_config({})
    message = str(exc_info.value)
    assert "URUSHI_API_BASE_URL" in message
    assert "URUSHI_SESSION_ID" in message
    assert "URUSHI_DEVICE_TOKEN" in message


def test_raises_when_only_one_var_is_missing():
    env = {"URUSHI_API_BASE_URL": "http://x", "URUSHI_SESSION_ID": "s"}
    with pytest.raises(ConfigError) as exc_info:
        load_config(env)
    assert "URUSHI_DEVICE_TOKEN" in str(exc_info.value)
    assert "URUSHI_API_BASE_URL" not in str(exc_info.value)


def test_optional_device_and_sample_rate_overrides():
    env = {
        "URUSHI_API_BASE_URL": "http://x",
        "URUSHI_SESSION_ID": "s",
        "URUSHI_DEVICE_TOKEN": "t",
        "URUSHI_INPUT_DEVICE": "EMEET OfficeCore M0 Plus",
        "URUSHI_OUTPUT_DEVICE": "3",
        "URUSHI_INPUT_SAMPLE_RATE": "8000",
        "URUSHI_OUTPUT_SAMPLE_RATE": "44100",
    }
    config = load_config(env)
    assert config.input_device == "EMEET OfficeCore M0 Plus"
    assert config.output_device == "3"
    assert config.input_sample_rate == 8000
    assert config.output_sample_rate == 44100


def test_input_and_output_sample_rates_default_independently():
    # Confirmed on real EMEET hardware: input only accepted 16000Hz, output only
    # accepted 48000Hz — these must never silently collapse to one shared value.
    env = {"URUSHI_API_BASE_URL": "http://x", "URUSHI_SESSION_ID": "s", "URUSHI_DEVICE_TOKEN": "t"}
    config = load_config(env)
    assert config.input_sample_rate != config.output_sample_rate
