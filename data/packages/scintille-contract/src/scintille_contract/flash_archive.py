"""Wire constraints shared with the browser's flash archive reader (ADR 0025)."""

import json
from importlib.resources import files
from typing import cast

_RULES = json.loads(files("scintille_contract").joinpath("flash_archive_rules.json").read_text())
FLASH_ARCHIVE_SCHEMA_VERSION = cast(int, _RULES["schema_version"])
FLASH_ARCHIVE_CHUNK_FLASHES = cast(int, _RULES["chunk_flashes"])
FLASH_ARCHIVE_MAX_HOUR_CHUNKS = cast(int, _RULES["max_hour_chunks"])
FLASH_ARCHIVE_MAX_MANIFEST_BYTES = cast(int, _RULES["max_manifest_bytes"])
FLASH_ARCHIVE_MAX_CHUNK_BYTES = cast(int, _RULES["max_chunk_bytes"])
FLASH_ARCHIVE_CHUNK_PATTERN = cast(str, _RULES["chunk_path_pattern"])
