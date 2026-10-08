"""Chunk encoding benchmark on 10 minutes of the synthetic feed."""

import gzip
import time
from collections.abc import Callable

import brotli  # type: ignore[import-untyped]

from scintille_contract import chunk, synthetic

SAMPLE = slice(60, 80)


def report() -> str:
    chunks = synthetic.chunks(synthetic.generate())[SAMPLE]
    flashes = sum(item.count for item in chunks)
    encodings: dict[str, Callable[[chunk.Chunk], bytes]] = {
        "columnar JSON": chunk.to_json,
        "binary (quantized)": chunk.encode,
    }
    compressions: dict[str, Callable[[bytes], bytes]] = {
        "none": lambda b: b,
        "gzip -9": lambda b: gzip.compress(b, compresslevel=9, mtime=0),
        "brotli -11": lambda b: brotli.compress(b, quality=11),
    }
    lines = [
        f"{flashes} flashes in {len(chunks)} chunks (10 minutes, {flashes / 600:.1f}/s)",
        "",
        "| Encoding | Compression | Total KB | Bytes/flash |",
        "|---|---|---:|---:|",
    ]
    for name, encode in encodings.items():
        raw = [encode(item) for item in chunks]
        for label, compress in compressions.items():
            size = sum(len(compress(item)) for item in raw)
            lines.append(f"| {name} | {label} | {size / 1000:.0f} | {size / flashes:.1f} |")
    started = time.perf_counter()
    for item in chunks:
        chunk.decode(chunk.encode(item))
    lines += ["", f"binary round trip: {(time.perf_counter() - started) * 1000:.1f} ms"]
    return "\n".join(lines)
