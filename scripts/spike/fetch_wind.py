import io, json, sys, time
from datetime import UTC, datetime
import numpy as np
import obstore
from obstore.store import S3Store
from PIL import Image
from scintille_ingest.clouds.gfs import candidates, decode_field, field_range, grib_key

LEVELS = {"10m": "10 m above ground", "850": "850 mb", "500": "500 mb", "250": "250 mb"}
SCALE = {"10m": 40.0, "850": 60.0, "500": 90.0, "250": 120.0}
valid = datetime.fromisoformat(sys.argv[1]).replace(tzinfo=UTC)
store = S3Store("noaa-gfs-bdp-pds", region="us-east-1", skip_signature=True)
for cycle, hours in candidates(valid):
    key = grib_key(cycle, hours)
    try:
        index = obstore.get(store, key + ".idx").bytes().to_bytes().decode()
        break
    except FileNotFoundError:
        continue
print("using", key)
report = {"key": key, "levels": {}}
for name, level in LEVELS.items():
    t0 = time.time()
    fields, nbytes = [], 0
    for var in ("UGRD", "VGRD"):
        start, end = field_range(index, f":{var}:{level}:")
        msg = obstore.get_range(store, key, start=start, end=end).to_bytes()
        nbytes += len(msg)
        fields.append(decode_field(bytes(msg)))
    u, v = fields
    np.save(f"{name}_{valid:%Y%m%dT%H}.npy", np.stack([u, v]).astype(np.float16))
    s = SCALE[name]
    sizes = {}
    for step, label in ((1, "0p25"), (2, "0p5"), (4, "1p0")):
        uu, vv = u[::step, ::step], v[::step, ::step]
        rg = np.clip(np.stack([uu, vv, np.zeros_like(uu)], -1) / s * 127.5 + 127.5, 0, 255).round().astype(np.uint8)
        img = Image.fromarray(rg, "RGB")
        for fmt, kw in (("png", {"optimize": True}), ("webp", {"lossless": True, "quality": 100, "method": 6})):
            buf = io.BytesIO(); img.save(buf, fmt, **kw); sizes[f"{label}.{fmt}"] = buf.tell()
            if label in ("0p5", "0p25") and fmt == "png":
                open(f"{name}_{label}.png", "wb").write(buf.getvalue())
    speed = np.hypot(u, v)
    report["levels"][name] = {"grib_bytes": nbytes, "seconds": round(time.time() - t0, 2), "max_ms": float(speed.max()), "p99_ms": float(np.percentile(speed, 99)), "mean_ms": float(speed.mean()), "sizes": sizes}
print(json.dumps(report, indent=1))
json.dump(report, open("report.json", "w"), indent=1)
