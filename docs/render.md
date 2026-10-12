# Headless rendering

The daily video (#95) and storm share images (#89) are frames of the globe exported by headless Chromium.

## Render page

`/render/` shows the globe alone, with nothing moving until a frame is asked for. It is `noindex` and kept
out of the sitemap. URL parameters:

| Parameter | Default | Meaning |
|---|---|---|
| `start`, `end` | required | Time range, ISO 8601 UTC. Frame `i` shows `start + i * (end - start) / frames`. |
| `frames` | 30 | Frame count. |
| `width`, `height` | 1920, 1080 | Canvas size in pixels (pixel ratio 1). |
| `quality` | `high` | Quality tier ([quality](quality.md)). |
| `lat`, `lon`, `alt`, `tilt` | 15, -40, 20000, 0 | View: point below the camera, height in km, degrees from nadir. |

The page exposes `window.scintilleRender`: `ready` resolves once the live feed and the textures are loaded
(it rejects when the range is not covered by loaded observations), and `frame(i)` draws frame `i` and
returns it as a PNG data URL. The feed is polled once, then frozen, so frames do not depend on timing.

## Renderer

```sh
pnpm -C web exec playwright install --with-deps --no-shell chromium
node web/scripts/render.mjs --url https://scintille.app --start <ISO> --end <ISO> --out frames/ [--gl gpu]
```

It accepts the page parameters above as `--name value` and writes `frame-00000.png`, … `--gl swiftshader`
(default) renders on the CPU and works anywhere; `--gl gpu` uses the machine's GPU when Chromium can.

The `render` workflow (manual) builds the site against the fixture hour, renders 30 frames twice with SwiftShader
and requires identical files; it also times a few 1080p frames in the job summary.
