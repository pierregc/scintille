# Surface detail comparison (#125)

Two prototypes on the globe, switched with `?surface=base|tiles|vectors|both` or Shift+S, in
development and PR previews only:

- `tiles`: raster pyramid from the 500 m Blue Marble and Black Marble releases, loaded by visible
  level (`src/globe/detail/tiles.ts`); `?texel=<css px>` sets the refinement threshold (default 2).
- `vectors`: Natural Earth 10m coastlines, borders, lakes and main cities as thin lines over the
  current textures (`src/globe/detail/vectors.ts`).

Run from `web/`:

```sh
node scripts/textures/tiles.mjs      # 1.2 GB of sources, about 3 min, out/tiles/
node scripts/textures/vectors.mjs    # out/vectors/lines.bin
mkdir -p scripts/textures/out/4k && for n in day night mask; do curl -so scripts/textures/out/4k/$n.webp https://data.scintille.app/textures/v2/4k/$n.webp; done
SCINTILLE_PR=125 PUBLIC_TEXTURES_URL=/textures PUBLIC_LIVE_BASE_URL=/data/ pnpm build
node spike/surface/serve.mjs         # http://localhost:4400, data proxied from data.scintille.app
node scripts/bench.mjs --refs ../docs/immersive/references.json --out bench/tiles \
  --url http://localhost:4400 --profile desktop --afterglow 0 --surface tiles
```

`serve.mjs` serves the build, the local textures, and proxies `/data/` to production with CORS
open, so the benchmark measures the same bytes as the deployed site. Results are in
[ADR 0022](../../../docs/adr/0022-surface-imagery.md).
