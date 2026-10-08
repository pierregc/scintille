"""Deterministic flash ids."""

import hashlib

from scintille_contract.models import Source


def flash_id(source: Source, product_file: str, native_flash_id: int) -> str:
    """Id that is identical every time the same product file is ingested."""
    key = f"{source}|{product_file}|{native_flash_id}".encode()
    return hashlib.sha256(key).hexdigest()[:32]
