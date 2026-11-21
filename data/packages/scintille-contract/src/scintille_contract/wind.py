"""Wire constraints of the wind frames, shared with the browser (ADR 0039)."""

import json
from importlib.resources import files
from typing import cast

_RULES = json.loads(files("scintille_contract").joinpath("wind_rules.json").read_text())
WIND_SCHEMA_VERSION = cast(int, _RULES["schema_version"])
WIND_WIDTH = cast(int, _RULES["width"])
WIND_HEIGHT = cast(int, _RULES["height"])
WIND_GRID_STEP = cast(float, _RULES["grid_step_degrees"])
WIND_SCALES = {name: cast(float, level["scale_ms"]) for name, level in _RULES["levels"].items()}
WIND_LEVELS = list(WIND_SCALES)
MAX_WIND_FRAMES = cast(int, _RULES["max_frames"])
MAX_WIND_MANIFEST_BYTES = cast(int, _RULES["max_manifest_bytes"])
MAX_WIND_FRAME_BYTES = cast(int, _RULES["max_frame_bytes"])
WIND_RETENTION_DAYS = cast(int, _RULES["retention_days"])
WIND_TEXTURE_PATTERN = cast(str, _RULES["texture_path_pattern"])
WIND_LIVE_TEXTURE_PATTERN = cast(str, _RULES["live_texture_path_pattern"])


def encode_component(value: float, scale: float) -> int:
    """Byte of one wind component: 128 is calm, 1 and 255 are -scale and +scale."""
    return round(max(-1.0, min(1.0, value / scale)) * 127) + 128


def decode_component(byte: int, scale: float) -> float:
    return (byte - 128) / 127 * scale
