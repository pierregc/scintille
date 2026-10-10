"""File and batch identities: a revised product is a new file, a re-run gives the same batch."""

import hashlib
from collections.abc import Iterable
from dataclasses import dataclass


@dataclass(frozen=True, order=True)
class FileIdentity:
    """Full object key plus content checksum."""

    key: str
    checksum: str

    @classmethod
    def of(cls, key: str, data: bytes) -> "FileIdentity":
        return cls(key, f"sha256:{hashlib.sha256(data).hexdigest()}")


def batch_id(files: Iterable[FileIdentity]) -> str:
    """Deterministic id of a batch, whatever the order its files are given in."""
    joined = "\n".join(f"{f.key}|{f.checksum}" for f in sorted(set(files)))
    return hashlib.sha256(joined.encode()).hexdigest()[:32]
