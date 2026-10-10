"""Rebuilds the embedded geocoding reference from Natural Earth and GeoNames.

Run from `data/`: `uv run python -m scintille_pipelines.geodata.build [download dir]`.
"""

import csv
import gzip
import hashlib
import io
import json
import sys
import urllib.request
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import shapely
from shapely.geometry import mapping, shape

HERE = Path(__file__).parent
NATURAL_EARTH = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson"
#: Natural Earth releases are tagged, so their checksums are pinned.
PINNED: dict[str, tuple[str, str]] = {
    "ne_50m_admin_0_countries.geojson": (
        f"{NATURAL_EARTH}/ne_50m_admin_0_countries.geojson",
        "3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb",
    ),
    "ne_10m_geography_marine_polys.geojson": (
        f"{NATURAL_EARTH}/ne_10m_geography_marine_polys.geojson",
        "53f865e8ffa966cdd402145c82c5cd14ee7ce974cd0eb9a3f59f03a4cfd2d66c",
    ),
}
#: GeoNames dumps are rebuilt daily: their checksums are recorded in the manifest instead.
GEONAMES = {
    "cities15000.zip": "https://download.geonames.org/export/dump/cities15000.zip",
    "admin1CodesASCII.txt": "https://download.geonames.org/export/dump/admin1CodesASCII.txt",
}
MARINE_KINDS = {
    "ocean", "sea", "gulf", "bay", "strait", "sound", "channel", "lagoon", "fjord", "inlet"
}  # fmt: skip
SKIPPED_PLACES = {"PPLX", "PPLH", "PPLQ", "PPLW"}
DIGITS = 3


def fetch(directory: Path, name: str, url: str) -> bytes:
    path = directory / name
    if not path.exists():
        with urllib.request.urlopen(url, timeout=120) as response:
            path.write_bytes(response.read())
    return path.read_bytes()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_gzip(path: Path, text: str) -> None:
    with path.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as out:
        out.write(text.encode())


def feature_collection(features: list[dict[str, Any]]) -> str:
    return json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":"))


def rounded(geometry: dict[str, Any]) -> dict[str, Any]:
    geom = shapely.make_valid(shapely.set_precision(shape(geometry), 10**-DIGITS))
    return dict(mapping(geom))


def countries(data: bytes) -> list[dict[str, Any]]:
    out = []
    for feature in json.loads(data)["features"]:
        p = feature["properties"]
        code = p["ISO_A2_EH"] if p["ISO_A2_EH"] != "-99" else None
        out.append(
            {
                "type": "Feature",
                "properties": {"code": code, "name": p["NAME_EN"]},
                "geometry": rounded(feature["geometry"]),
            }
        )
    return out


def marine(data: bytes) -> list[dict[str, Any]]:
    out = []
    for feature in json.loads(data)["features"]:
        p = feature["properties"]
        if p["featurecla"] not in MARINE_KINDS or not p["name"]:
            continue
        # `name` keeps "North"/"South" for oceans, `name_en` is English for the rest.
        name = p["name"].title() if p["featurecla"] == "ocean" else p["name_en"]
        out.append(
            {
                "type": "Feature",
                "properties": {"name": name, "kind": p["featurecla"]},
                "geometry": rounded(feature["geometry"]),
            }
        )
    return out


def places(cities: bytes, admin1: bytes, borders: list[dict[str, Any]]) -> str:
    regions = {}
    for row in csv.reader(io.StringIO(admin1.decode()), delimiter="\t"):
        regions[row[0]] = row[1]
    with zipfile.ZipFile(io.BytesIO(cities)) as archive:
        text = archive.read("cities15000.txt").decode()
    rows = []
    for row in csv.reader(io.StringIO(text), delimiter="\t", quoting=csv.QUOTE_NONE):
        if row[7] in SKIPPED_PLACES:
            continue
        region = regions.get(f"{row[8]}.{row[10]}")
        rows.append((int(row[0]), row[1], float(row[4]), float(row[5]), row[8], region, row[14]))
    rows.sort()
    by_code = {f["properties"]["code"]: f["properties"]["name"] for f in borders}
    tree = shapely.STRtree([shape(f["geometry"]) for f in borders])
    # Territories with their own GeoNames code (GF, RE…) take the border they lie in or next to.
    points = shapely.points([r[3] for r in rows], [r[2] for r in rows])
    found, index = tree.query_nearest(points, max_distance=0.5)
    nearest = dict(zip(found.tolist(), index.tolist(), strict=True))
    out = io.StringIO()
    writer = csv.writer(out, delimiter="\t", lineterminator="\n")
    writer.writerow(["name", "lat", "lon", "country", "region", "population"])
    for i, (_, name, lat, lon, code, region, population) in enumerate(rows):
        country = by_code.get(code) or (
            borders[nearest[i]]["properties"]["name"] if i in nearest else ""
        )
        writer.writerow(
            [name, round(lat, DIGITS), round(lon, DIGITS), country, region or "", population]
        )
    return out.getvalue()


def main(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    sources: dict[str, dict[str, str]] = {}
    raw: dict[str, bytes] = {}
    for name, (url, pinned) in PINNED.items():
        raw[name] = fetch(directory, name, url)
        if sha256(raw[name]) != pinned:
            raise ValueError(f"{name} does not match its pinned checksum")
        sources[name] = {"url": url, "sha256": sha256(raw[name])}
    for name, url in GEONAMES.items():
        raw[name] = fetch(directory, name, url)
        sources[name] = {"url": url, "sha256": sha256(raw[name])}
    borders = countries(raw["ne_50m_admin_0_countries.geojson"])
    write_gzip(HERE / "countries.geojson.gz", feature_collection(borders))
    seas = marine(raw["ne_10m_geography_marine_polys.geojson"])
    write_gzip(HERE / "marine.geojson.gz", feature_collection(seas))
    table = places(raw["cities15000.zip"], raw["admin1CodesASCII.txt"], borders)
    write_gzip(HERE / "places.tsv.gz", table)
    manifest = {
        "version": f"ne-5.1.2+geonames-{datetime.now(UTC).date().isoformat()}",
        "sources": sources,
    }
    (HERE / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / ".cache" / "scintille")
