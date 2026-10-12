#!/usr/bin/env bash
# Local version of the render workflow: the fixture hour rendered twice must give identical frames.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root/web"
range=(--start 2026-07-15T18:30:00Z --end 2026-07-15T18:31:00Z --frames 30)
out=$(mktemp -d)
pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true; rm -rf "$out"' EXIT

pnpm install --frozen-lockfile
pnpm exec playwright install chromium
PUBLIC_LIVE_BASE_URL=http://127.0.0.1:8799/ PUBLIC_TEXTURES_URL=/textures pnpm build
mkdir -p dist/client/textures/4k
for name in day night mask; do
	curl -fsS --retry 3 -o "dist/client/textures/4k/$name.webp" "https://data.scintille.app/textures/v2/4k/$name.webp"
done
python3 ../fixtures/serve.py 8799 & pids+=($!)
python3 -m http.server 4399 -b 127.0.0.1 -d dist/client & pids+=($!)
curl -fsS --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:4399/render/
curl -fsS --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:8799/live/manifest.json

node scripts/render.mjs --url http://127.0.0.1:4399 "${range[@]}" --width 640 --height 360 --out "$out/a"
node scripts/render.mjs --url http://127.0.0.1:4399 "${range[@]}" --width 640 --height 360 --out "$out/b"
(cd "$out/a" && shasum -a 256 -- *.png) > "$out/a.sha256"
(cd "$out/b" && shasum -a 256 -- *.png) > "$out/b.sha256"
test "$(wc -l < "$out/a.sha256")" -eq 30
diff "$out/a.sha256" "$out/b.sha256"
echo "30 identical frames"
