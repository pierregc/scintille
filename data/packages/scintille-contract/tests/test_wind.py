import re

import pytest
from scintille_contract.wind import (
    WIND_LEVELS,
    WIND_LIVE_TEXTURE_PATTERN,
    WIND_SCALES,
    WIND_TEXTURE_PATTERN,
    decode_component,
    encode_component,
)


def test_levels() -> None:
    assert WIND_LEVELS == ["10m", "250hPa"]
    assert WIND_SCALES == {"10m": 40, "250hPa": 120}


@pytest.mark.parametrize(("value", "byte"), [(0.0, 128), (40.0, 255), (-40.0, 1), (99.0, 255)])
def test_encode(value: float, byte: int) -> None:
    assert encode_component(value, 40) == byte


def test_round_trip_within_half_a_step() -> None:
    for value in (-37.3, -1.2, 0.4, 12.9):
        assert abs(decode_component(encode_component(value, 40), 40) - value) <= 40 / 127 / 2


def test_paths() -> None:
    name = "250hPa/2026/11/21/20261121T13Z-1a2b3c4d.webp"
    assert re.fullmatch(WIND_TEXTURE_PATTERN, f"../{name}")
    assert re.fullmatch(WIND_LIVE_TEXTURE_PATTERN, f"../../archive/wind/{name}")
    assert not re.fullmatch(WIND_TEXTURE_PATTERN, "../../x/10m/2026/11/21/a.webp")
