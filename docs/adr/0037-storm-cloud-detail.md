# 0037 · 0.5 km cloud detail under strong storms

- Status: accepted
- Date: 2026-11-06
- Extends the detail tiles of [ADR 0023](0023-composite-clouds.md) and the volume windows of
  [ADR 0031](0031-cloud-look.md)

## Context

Maintainer QA of 2026-11-05: close views of the clouds look soft. Ingestion averages the 0.5 km
visible channels (GOES ABI band 2, Himawari AHI band 3, MTG FCI `vis_06_hr`) to 1 km, and at the
400 km floor a 1 km texel spans four pixels. Spike #428 found that sharpening only crisps edges;
only the native resolution adds detail. A global 0.5 km level would quadruple the level 5 work and
bytes (#437).

## Options

- **Sharpen the 1 km tiles** on the VPS or in the browser: crisper edges, no new cloud (#428).
- **A global level 6**: about four times the level 5 tiles, render time and R2 bytes.
- **Level 6 by day under strong storms** (chosen, approved by the maintainer): where close views go.

## Decision

1. **Where**: tiles of level 6 (640 texels of about 0.49 km) touching a disc around the cells of
   level 4 and up in `storms/active.json`, their path within an hour of the frame, radius the cell's
   plus 150 km; only tiles where the sun is over 13° somewhere (the visible weighs fully), only under
   a level 5 tile.
2. **Ingestion**: readers keep the native visible only in windows around those tiles (parallax up to
   15 km included), so memory stays flat. Level 6 uses the level 5 rule with the visible at its native
   resolution; its detail ratio is smoothed over the same 1 km, so levels 5 and 6 agree.
3. **Contract**: an optional `storm` block in `detail` lists the tiles and a sparse index after the
   other indexes; old packs and old clients are unchanged. Storm packs keep level 6 under their storms.
4. **Client**: the detail cache and its page table go down to level 6; the volume gets a seventh
   window of 0.5 km around the ground looked at, baked only while level 6 tiles are loaded there.
   The relief light keeps reading the 1 km window and coarser.

## Consequences

- One real hour (2026-11-05 12:00, upper bound of 185 storm tiles from the catalog): pack 37.7 →
  44.2 MB, render 128 → 153 s, peak memory unchanged (main 2.37 GB, workers 1.77 GB).
- R2: at most about 6.5 MB more per frame for the day the full pack is kept, and some level 6 tiles
  in the 30 day storm packs.
- Away from strong daytime storms, nothing changes; at night the infrared stays at 1 to 2 km.
