"""Wire constraints shared with the browser's historical cloud reader."""

import json
from importlib.resources import files
from typing import cast

_RULES = json.loads(files("scintille_contract").joinpath("cloud_archive_rules.json").read_text())
ARCHIVE_SCHEMA_VERSION = cast(int, _RULES["schema_version"])
MAX_ARCHIVE_FRAMES = cast(int, _RULES["max_frames"])
MAX_CLOUD_FRAME_BYTES = cast(int, _RULES["max_frame_bytes"])
ARCHIVE_TEXTURE_PATTERN = cast(str, _RULES["texture_path_pattern"])
ARCHIVE_DETAIL_PATTERN = cast(str, _RULES["detail_path_pattern"])
DETAIL_LEVELS = cast(list[int], _RULES["detail_levels"])
DETAIL_TILE_SIZE = cast(int, _RULES["detail_tile_size"])
DETAIL_BORDER = cast(int, _RULES["detail_border"])
CLOUD_TIERS = cast(list[str], _RULES["tiers"])
