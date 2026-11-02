# Baseline of the lightning look (2026-10-31)

Captures and measurements of the renderer on `main` (2398beb, a few lines of the lightning shaders before b1b35cf) before
the lightning look rework ([#398](https://github.com/pierregc/scintille/issues/398)), so its tickets got
measurable acceptance criteria. Kept as written on 2026-10-31; the after-pictures and the measured targets
are in [immersive view, Lightning look validation](../../immersive-view.md#lightning-look-validation).

- Captures: 58 captures of four frames, 1600 × 1000, headless Chromium with the GPU, clouds on, afterglow 0.
  They are not in the repository; frame 1 of each is in the contact sheets
  [`baseline-bk-day.jpg`](baseline-bk-day.jpg) (Basse-Kotto 05:30 to 12:00),
  [`baseline-bk-evening.jpg`](baseline-bk-evening.jpg) (Basse-Kotto 15:30 to 17:30) and
  [`baseline-night.jpg`](baseline-night.jpg) (Amazonas and R1), and the magnified crops in
  [`baseline-crops.jpg`](baseline-crops.jpg). File names below are those of the captures.
- The capture tool is now [`web/scripts/capture.mjs`](../../../web/scripts/capture.mjs); `<scratchpad>` is
  the rework's working folder (statistics JSON, batch scripts), not in the repository.

## 1. Protocol

`node <scratchpad>/tools/capture.mjs --base http://localhost:4321 --storm S --time T --speed N [--view ...] --frames 4 --gap 700 --settle 12 --play-before P`, with `P = 1500` ms at 60× and 600× and `P = 500` ms at 3600× (1.5 s of play at 3600× would have moved the scene 90 min before the first frame; 0.5 s moves it 30 min). The four frames are 0.7 s of wall time apart: 42 s of scene time at 60×, 7 min at 600×, 42 min at 3600×. The scene-time column of the table gives the actual range of the frames.

Views, per the brief: *whole* = no `--view` (the app frames the storm, `REPLAY_FRAME.tilt` 20°, 1,827 km range on Basse-Kotto); *oblique* = cell, 500 km, tilt 45; *iss* = cell, 400 km, tilt 1; *window* = 0.6° north of the cell, 740 km, tilt 60, heading 200. Cells = the hourly track point of the hour (brief values at 12:00; track file for the others):

| Scene | Cell (lat, lon) | Sun |
|---|---|---|
| Basse-Kotto 05:30Z | 3.647, 22.677 | 0° (dawn, weak: 5–11 flashes/min) |
| 09:00Z | 4.300, 21.470 | 63° |
| 12:00Z | 3.4, 19.9 | 61° (peak) |
| 15:30Z | 2.872, 18.141 | 20° |
| 16:45Z | 3.601, 17.158 | −2° (twilight) |
| 17:30Z | 3.441, 16.740 | −17° (night, weak) |
| Amazonas 2026-10-31 00:30Z | −7.105, −64.474 | night |
| Amazonas 02:00Z | −7.828, −64.558 | night, dying |
| Minas Gerais R1 2026-10-18 23:15Z | −14.56, −44.26 | −33° |

Notes on the protocol:

- The first pass failed on the two southern storms because `parseArgs` reads `--view -7.1,...` as an option; `--view=-7.1,...` works (second pass, `batch-baseline-2.sh`). No capture failed after that, no page or shader error in any `.json`.
- The R1 replay (2026-10-18) had **not** expired: 343–369 flashes started per wall second at 60×, with its city lights and clouds.
- The cell aimed at is the hourly centroid of the track. At 12:00 the densest point of the last minute is at **lat 4.17, lon 19.92**, 90 km north of the centroid (see §3): the oblique and iss frames have the busiest cell in their upper third, not at the centre. For the re-capture matrix (§7) aim at the densest point.
- At 3600× the camera does not move while the storm travels ~100 km in 2 s of wall time: the frames at 15:30 + 3600× show the cell leaving the top-left corner of the frame (`1530-3600-iss`). Captures at 3600× need `Follow` or a shorter window.
- Metrics (`white` = share of pixels with every channel > 235, `lit` = luminance > 90, `blobs` = lit 8 × 8 blocks, central 84 % × 76 % of the frame): **by day they measure the sunlit cloud deck as much as the lightning.** Every daytime view at the floor gives `lit` 100 % and `blobs` 15,960 (every block), and `white` at 05:30 (sun 0°) is 0.03–0.3 % while at 09:00 and 12:00 it starts at 0.5–3 % with only ~200–550 flashes. The night and twilight scenes (16:45, 17:30, Amazonas, R1) isolate the lightning and are the ones to compare against ADR 0020's 2 % near-white budget. `flashes` = flashes started within the last wall second of scene time (60 s, 10 min, 1 h of scene time at 60×, 600×, 3600×).

## 2. Every capture

Ranges are over the four frames of a capture. Paths are relative to `<scratchpad>/`.

| Storm | Scene time (frames 0..3) | Speed | View | Flashes started in the last wall second | White % | Lit % | Blobs | Errors | Files |
|---|---|---|---|---|---|---|---|---|---|
| 2026-10-18-minas-gerais-7 | 23:16..23:19Z | 60 | oblique | 343..369 | 1.35..1.68 | 15.6..17.0 | 3129..3363 | - | `captures/baseline/2026-10-18-minas-gerais-7/2315-60-oblique-{0..3}.png` |
| 2026-10-18-minas-gerais-7 | 23:30..23:57Z | 600 | oblique | 3014..3366 | 4.78..5.60 | 23.1..25.4 | 4258..4658 | - | `captures/baseline/2026-10-18-minas-gerais-7/2315-600-oblique-{0..3}.png` |
| 2026-10-27-basse-kotto | 05:31..05:34Z | 60 | whole | 5..11 | 0.03..0.27 | 65.7..66.2 | 11089..11180 | - | `captures/baseline/2026-10-27-basse-kotto/0530-60-whole-{0..3}.png` |
| 2026-10-27-basse-kotto | 05:31..05:34Z | 60 | oblique | 5..10 | 0.04..0.21 | 86.0..86.5 | 14024..14110 | - | `captures/baseline/2026-10-27-basse-kotto/0530-60-oblique-{0..3}.png` |
| 2026-10-27-basse-kotto | 05:31..05:34Z | 60 | iss | 5..11 | 0.13..0.32 | 90.8..91.3 | 14674..14737 | - | `captures/baseline/2026-10-27-basse-kotto/0530-60-iss-{0..3}.png` |
| 2026-10-27-basse-kotto | 05:31..05:34Z | 60 | window | 6..11 | 0.04..0.07 | 82.0..82.4 | 13450..13528 | - | `captures/baseline/2026-10-27-basse-kotto/0530-60-window-{0..3}.png` |
| 2026-10-27-basse-kotto | 09:01..09:04Z | 60 | whole | 188..205 | 1.59..2.00 | 97.0..97.2 | 15739..15756 | - | `captures/baseline/2026-10-27-basse-kotto/0900-60-whole-{0..3}.png` |
| 2026-10-27-basse-kotto | 09:01..09:04Z | 60 | oblique | 184..206 | 1.22..1.41 | 100.0 | 15960 | - | `captures/baseline/2026-10-27-basse-kotto/0900-60-oblique-{0..3}.png` |
| 2026-10-27-basse-kotto | 09:01..09:04Z | 60 | iss | 187..208 | 2.44..3.58 | 99.8..100.0 | 15959..15960 | - | `captures/baseline/2026-10-27-basse-kotto/0900-60-iss-{0..3}.png` |
| 2026-10-27-basse-kotto | 09:01..09:04Z | 60 | window | 186..203 | 0.53..0.69 | 100.0 | 15960 | - | `captures/baseline/2026-10-27-basse-kotto/0900-60-window-{0..3}.png` |
| 2026-10-27-basse-kotto | 12:01..12:04Z | 60 | whole | 527..591 | 2.83..3.75 | 93.9..94.4 | 15402..15466 | - | `captures/baseline/2026-10-27-basse-kotto/1200-60-whole-{0..3}.png` |
| 2026-10-27-basse-kotto | 12:01..12:04Z | 60 | oblique | 516..591 | 1.23..1.87 | 100.0 | 15960 | - | `captures/baseline/2026-10-27-basse-kotto/1200-60-oblique-{0..3}.png` |
| 2026-10-27-basse-kotto | 12:01..12:04Z | 60 | iss | 518..586 | 1.57..2.60 | 100.0 | 15960 | - | `captures/baseline/2026-10-27-basse-kotto/1200-60-iss-{0..3}.png` |
| 2026-10-27-basse-kotto | 12:01..12:04Z | 60 | window | 522..596 | 0.84..0.98 | 100.0..100.0 | 15960 | - | `captures/baseline/2026-10-27-basse-kotto/1200-60-window-{0..3}.png` |
| 2026-10-27-basse-kotto | 12:15..12:44Z | 600 | whole | 6050..6519 | 5.59..6.89 | 96.1..97.2 | 15606..15703 | - | `captures/baseline/2026-10-27-basse-kotto/1200-600-whole-{0..3}.png` |
| 2026-10-27-basse-kotto | 12:15..12:42Z | 600 | oblique | 6061..6527 | 2.78..4.15 | 100.0 | 15960 | - | `captures/baseline/2026-10-27-basse-kotto/1200-600-oblique-{0..3}.png` |
| 2026-10-27-basse-kotto | 12:15..12:41Z | 600 | iss | 6061..6556 | 5.13..12.95 | 100.0 | 15960 | - | `captures/baseline/2026-10-27-basse-kotto/1200-600-iss-{0..3}.png` |
| 2026-10-27-basse-kotto | 12:15..12:43Z | 600 | window | 6058..6535 | 1.39..2.14 | 99.7..100.0 | 15928..15960 | - | `captures/baseline/2026-10-27-basse-kotto/1200-600-window-{0..3}.png` |
| 2026-10-27-basse-kotto | 12:30..15:25Z | 3600 | whole | 29454..37482 | 5.72..10.06 | 87.7..98.3 | 14455..15790 | - | `captures/baseline/2026-10-27-basse-kotto/1200-3600-whole-{0..3}.png` |
| 2026-10-27-basse-kotto | 12:30..15:12Z | 3600 | oblique | 32733..37484 | 4.54..13.58 | 100.0..100.0 | 15960 | - | `captures/baseline/2026-10-27-basse-kotto/1200-3600-oblique-{0..3}.png` |
| 2026-10-27-basse-kotto | 12:30..15:09Z | 3600 | iss | 33008..37465 | 2.53..30.86 | 100.0 | 15960 | - | `captures/baseline/2026-10-27-basse-kotto/1200-3600-iss-{0..3}.png` |
| 2026-10-27-basse-kotto | 12:30..15:17Z | 3600 | window | 31398..37444 | 2.85..6.00 | 99.6..100.0 | 15916..15960 | - | `captures/baseline/2026-10-27-basse-kotto/1200-3600-window-{0..3}.png` |
| 2026-10-27-basse-kotto | 15:31..15:34Z | 60 | whole | 322..344 | 1.06..1.29 | 77.3..78.9 | 12843..13122 | - | `captures/baseline/2026-10-27-basse-kotto/1530-60-whole-{0..3}.png` |
| 2026-10-27-basse-kotto | 15:31..15:34Z | 60 | oblique | 322..340 | 1.22..1.38 | 93.8..93.9 | 15069..15081 | - | `captures/baseline/2026-10-27-basse-kotto/1530-60-oblique-{0..3}.png` |
| 2026-10-27-basse-kotto | 15:31..15:34Z | 60 | iss | 322..347 | 0.84..1.47 | 99.9..100.0 | 15954..15960 | - | `captures/baseline/2026-10-27-basse-kotto/1530-60-iss-{0..3}.png` |
| 2026-10-27-basse-kotto | 15:31..15:34Z | 60 | window | 322..341 | 0.58..0.77 | 95.4..95.7 | 15458..15499 | - | `captures/baseline/2026-10-27-basse-kotto/1530-60-window-{0..3}.png` |
| 2026-10-27-basse-kotto | 15:45..16:14Z | 600 | whole | 1045..3290 | 1.20..3.26 | 52.6..77.2 | 8819..12836 | - | `captures/baseline/2026-10-27-basse-kotto/1530-600-whole-{0..3}.png` |
| 2026-10-27-basse-kotto | 15:45..16:12Z | 600 | oblique | 1087..3312 | 2.79..3.41 | 94.3..95.5 | 15139..15320 | - | `captures/baseline/2026-10-27-basse-kotto/1530-600-oblique-{0..3}.png` |
| 2026-10-27-basse-kotto | 15:45..16:11Z | 600 | iss | 1100..3315 | 2.54..5.96 | 99.9..100.0 | 15957..15960 | - | `captures/baseline/2026-10-27-basse-kotto/1530-600-iss-{0..3}.png` |
| 2026-10-27-basse-kotto | 15:45..16:12Z | 600 | window | 1087..3309 | 1.57..1.95 | 93.9..96.2 | 15289..15563 | - | `captures/baseline/2026-10-27-basse-kotto/1530-600-window-{0..3}.png` |
| 2026-10-27-basse-kotto | 16:00..18:50Z | 3600 | whole | 41..20305 | 0.01..4.99 | 0.8..70.7 | 327..11819 | - | `captures/baseline/2026-10-27-basse-kotto/1530-3600-whole-{0..3}.png` |
| 2026-10-27-basse-kotto | 16:04..18:41Z | 3600 | oblique | 107..19354 | 0.13..5.72 | 3.6..95.3 | 854..15295 | - | `captures/baseline/2026-10-27-basse-kotto/1530-3600-oblique-{0..3}.png` |
| 2026-10-27-basse-kotto | 16:00..18:37Z | 3600 | iss | 142..20305 | 0.02..8.83 | 6.8..100.0 | 1379..15960 | - | `captures/baseline/2026-10-27-basse-kotto/1530-3600-iss-{0..3}.png` |
| 2026-10-27-basse-kotto | 16:00..18:42Z | 3600 | window | 96..20305 | 0.06..2.95 | 1.2..95.8 | 462..15546 | - | `captures/baseline/2026-10-27-basse-kotto/1530-3600-window-{0..3}.png` |
| 2026-10-27-basse-kotto | 16:46..16:49Z | 60 | whole | 39..55 | 0.16..0.25 | 4.4..10.7 | 1021..2026 | - | `captures/baseline/2026-10-27-basse-kotto/1645-60-whole-{0..3}.png` |
| 2026-10-27-basse-kotto | 16:46..16:49Z | 60 | oblique | 36..55 | 0.21..0.35 | 2.1..6.5 | 692..1366 | - | `captures/baseline/2026-10-27-basse-kotto/1645-60-oblique-{0..3}.png` |
| 2026-10-27-basse-kotto | 16:46..16:48Z | 60 | iss | 39..55 | 0.28..0.80 | 5.9..14.4 | 1395..2723 | - | `captures/baseline/2026-10-27-basse-kotto/1645-60-iss-{0..3}.png` |
| 2026-10-27-basse-kotto | 16:46..16:49Z | 60 | window | 36..55 | 0.08..0.17 | 3.3..6.5 | 929..1454 | - | `captures/baseline/2026-10-27-basse-kotto/1645-60-window-{0..3}.png` |
| 2026-10-27-basse-kotto | 17:00..17:26Z | 600 | whole | 116..167 | 0.66..0.90 | 3.3..4.8 | 745..1005 | - | `captures/baseline/2026-10-27-basse-kotto/1645-600-whole-{0..3}.png` |
| 2026-10-27-basse-kotto | 17:00..17:24Z | 600 | oblique | 118..171 | 1.67..2.05 | 7.3..10.4 | 1532..2006 | - | `captures/baseline/2026-10-27-basse-kotto/1645-600-oblique-{0..3}.png` |
| 2026-10-27-basse-kotto | 17:00..17:25Z | 600 | iss | 117..174 | 3.44..4.66 | 19.0..24.6 | 3485..4281 | - | `captures/baseline/2026-10-27-basse-kotto/1645-600-iss-{0..3}.png` |
| 2026-10-27-basse-kotto | 17:00..17:25Z | 600 | window | 116..174 | 0.57..0.69 | 2.2..2.7 | 572..697 | - | `captures/baseline/2026-10-27-basse-kotto/1645-600-window-{0..3}.png` |
| 2026-10-27-basse-kotto | 17:31..17:34Z | 60 | whole | 16..17 | 0.01..0.13 | 0.4..1.6 | 282..475 | - | `captures/baseline/2026-10-27-basse-kotto/1730-60-whole-{0..3}.png` |
| 2026-10-27-basse-kotto | 17:31..17:33Z | 60 | oblique | 15..18 | 0.00..0.04 | 0.6..2.9 | 403..740 | - | `captures/baseline/2026-10-27-basse-kotto/1730-60-oblique-{0..3}.png` |
| 2026-10-27-basse-kotto | 17:31..17:33Z | 60 | iss | 16..19 | 0.02..0.06 | 1.9..6.4 | 647..1359 | - | `captures/baseline/2026-10-27-basse-kotto/1730-60-iss-{0..3}.png` |
| 2026-10-27-basse-kotto | 17:31..17:33Z | 60 | window | 16..18 | 0.00..0.02 | 0.2..0.8 | 291..382 | - | `captures/baseline/2026-10-27-basse-kotto/1730-60-window-{0..3}.png` |
| 2026-10-30-amazonas-140 | 00:31..00:34Z | 60 | oblique | 101..109 | 0.53..0.70 | 13.0..16.1 | 2638..3124 | - | `captures/baseline/2026-10-30-amazonas-140/0030-60-oblique-{0..3}.png` |
| 2026-10-30-amazonas-140 | 00:31..00:34Z | 60 | iss | 99..111 | 0.46..1.39 | 25.5..44.1 | 4559..7487 | - | `captures/baseline/2026-10-30-amazonas-140/0030-60-iss-{0..3}.png` |
| 2026-10-30-amazonas-140 | 00:45..01:11Z | 600 | oblique | 750..988 | 8.37..10.31 | 37.3..39.6 | 6486..6763 | - | `captures/baseline/2026-10-30-amazonas-140/0030-600-oblique-{0..3}.png` |
| 2026-10-30-amazonas-140 | 00:45..01:13Z | 600 | iss | 713..991 | 14.05..27.59 | 61.9..75.8 | 10268..12330 | - | `captures/baseline/2026-10-30-amazonas-140/0030-600-iss-{0..3}.png` |
| 2026-10-30-amazonas-140 | 01:00..03:44Z | 3600 | oblique | 282..6473 | 0.91..17.18 | 15.3..48.6 | 2700..8095 | - | `captures/baseline/2026-10-30-amazonas-140/0030-3600-oblique-{0..3}.png` |
| 2026-10-30-amazonas-140 | 01:00..03:57Z | 3600 | iss | 97..6473 | 0.00..36.03 | 15.1..84.8 | 2687..13656 | - | `captures/baseline/2026-10-30-amazonas-140/0030-3600-iss-{0..3}.png` |
| 2026-10-30-amazonas-140 | 02:01..02:03Z | 60 | oblique | 18..27 | 0.03..0.38 | 3.2..17.6 | 871..3121 | - | `captures/baseline/2026-10-30-amazonas-140/0200-60-oblique-{0..3}.png` |
| 2026-10-30-amazonas-140 | 02:01..02:04Z | 60 | iss | 18..24 | 0.04..0.54 | 8.1..40.6 | 1697..6864 | - | `captures/baseline/2026-10-30-amazonas-140/0200-60-iss-{0..3}.png` |
| 2026-10-30-amazonas-140 | 02:15..02:40Z | 600 | oblique | 189..195 | 2.13..3.26 | 15.1..20.0 | 2703..3472 | - | `captures/baseline/2026-10-30-amazonas-140/0200-600-oblique-{0..3}.png` |
| 2026-10-30-amazonas-140 | 02:15..02:42Z | 600 | iss | 188..195 | 5.20..6.04 | 41.6..52.7 | 7007..8746 | - | `captures/baseline/2026-10-30-amazonas-140/0200-600-iss-{0..3}.png` |
| 2026-10-30-amazonas-140 | 02:30..05:02Z | 3600 | oblique | 0..1814 | 0.00..9.94 | 0.1..28.9 | 182..4946 | - | `captures/baseline/2026-10-30-amazonas-140/0200-3600-oblique-{0..3}.png` |
| 2026-10-30-amazonas-140 | 02:30..05:10Z | 3600 | iss | 0..1814 | 0.00..25.50 | 0.1..68.2 | 173..11175 | - | `captures/baseline/2026-10-30-amazonas-140/0200-3600-iss-{0..3}.png` |

Reading of the table:

- **Budget already hit at 60× during the peak.** 516–596 flashes start per wall second at 12:00 (data: 384–699/min, §3) while the storm view keeps the 500 newest (`STORM_VIEW_FLASHES`, `web/src/globe/lightning/index.ts:105`, `budgetStart` line 349): 50–100 flashes/s are cut before their 1 s life even at 60×. At 600× 6,050–6,560 flashes start per wall second: each flash keeps the screen 500 / 6,500 ≈ 77 ms (4–5 frames), i.e. its first pulse only; at 3600× 29,000–37,500 start per wall second, 500 / 35,000 ≈ 14 ms, under one frame. Channels are built at most 24 per frame (`BUILDS_PER_FRAME`, `channel-pool.ts:12`): at 3600× by day about 600 flashes start per frame, so ~4 % ever get a channel and the picture is glow only (`1200-3600-*`, no channel visible in any frame).
- **Near-white pixels at night** (the honest measure): 60× 0.0–0.35 % on Basse-Kotto at 16:45/17:30, 0.5–1.4 % on Amazonas, 1.35–1.7 % on R1; 600× 1.7–4.7 % (Basse-Kotto twilight), 4.8–5.6 % (R1), 8.4–27.6 % (Amazonas); 3600× up to 8.8 % (Basse-Kotto iss), 17–36 % (Amazonas). ADR 0020 budget: ≤ 2 %. 60× passes at night, 600× and 3600× fail everywhere except on a dying storm.
- **Lit share and blobs at night** grow with speed as expected: Amazonas oblique 13–16 % lit / 2,600–3,100 blobs at 60×, 37–40 % / 6,500–6,800 at 600×, up to 49 % / 8,100 at 3600×; iss 26–44 % → 62–76 % → 85 %.
- **White pixels by day** reach 13 % (600× iss) and 31 % (3600× iss) at 12:00: the cloud light plus the glows push whole regions of the already-white deck to pure white (`1200-3600-iss-1.png`, white 30.9 %).

## 3. Data statistics (ring read from the browser, paused at the playhead)

### Basse-Kotto, playhead 12:00:00Z

Ring: 212,695 flashes (capacity 262,144, so the whole replay is in the ring, 04:00:06Z to 19:25:28Z; `archive/index.ts` `update()` slides a window of `min(archive.size, capacity)` around the playhead). One source only (MTG LI, source code 2): no cross-instrument duplicates.

| | Whole replay (212,695) | 11:30–12:30Z (32,965) | Last 10 min before 12:00 (4,352) | Last 1 min (384) |
|---|---|---|---|---|
| Radius √(area/π) km, p5 / p25 / **p50** / p75 / p95 | 2.7 / 4.7 / **6.6** / 8.8 / 13.6 | 2.7 / 4.7 / **6.0** / 8.1 / 12.0 | 2.7 / 4.7 / **6.0** / 8.1 / 12.0 | 2.7 / 4.7 / **6.0** / 8.5 / 12.0 |
| Duration ms, p5 / p25 / **p50** / p75 / p95 | 1 / 59 / **199** / 383 / 768 | 1 / 42 / **170** / 326 / 644 | 1 / 50 / **183** / 343 / 652 | 1 / 71 / **195** / 364 / 680 |
| Intensity, p5 / p25 / **p50** / p75 / p95 | 0.21 / 0.40 / **0.52** / 0.64 / 0.81 | 0.21 / 0.38 / **0.50** / 0.60 / 0.76 | 0.20 / 0.40 / **0.51** / 0.61 / 0.77 | 0.18 / 0.40 / **0.52** / 0.64 / 0.80 |
| Duration < 100 / 100–300 / 300–600 / > 600 ms | 32.4 / 32.9 / 24.6 / 10.2 % | 36.4 / 35.2 / 22.2 / 6.3 % | 34.5 / 35.1 / 23.9 / 6.5 % | 32.0 / 35.7 / 24.5 / 7.8 % |
| Densest point (lat, lon) | 4.475, 19.895 | 4.471, 19.910 | 4.460, 19.915 | 4.173, 19.915 |
| Share within 10 km / 25 km / 50 km of it | 0.8 / 1.7 / 5.6 % | 4.1 / 8.8 / 24.2 % | 6.2 / 16.6 / 29.5 % | 8.3 / 10.7 / 39.8 % |
| Median / p90 distance to it | 185 / 341 km | 104 / 336 km | 93 / 285 km | 66 / 258 km |

- The radius floor in the renderer is 3 km (`max(3, r)`, `skeleton.ts`): 5 % of the flashes sit on it; the median flash lights a 6 km radius disc, the 95th percentile 12–14 km. (Note the brief's "typically 5 to 19 km" is R1's GLM-heavy distribution; LI-only Basse-Kotto is smaller.)
- A third of the flashes last under 100 ms (a single blink in the profile), a third 100–300 ms, a quarter 300–600, 6–10 % over 600 ms (clamped to 1 s on screen).
- **The storm is not one point.** In the busiest minute only 8 % of the flashes fall within 10 km of the densest point and 40 % within 50 km; the median flash of the hour is 104 km from it, p90 336 km: the "ball" is a rendering effect of overlapping glows and cloud light at the densest cell, not the data. The hourly centroid (3.38, 19.88) is 90–120 km south of the densest cell (4.2–4.5, 19.9) at 12:00.
- Flashes per minute 11:30–12:30: min 384 (the 11:59–12:00 minute, a local dip), max 699, mean 549 (485 over 11:30–12:00, 614 over 12:00–12:30). Full list in the JSON.

Flashes starting within one wall second, by replay speed (sliding windows over 10:30–15:30Z, step 10 s / 1 min / 5 min):

| Speed | Scene time per wall second | Max | Median | At 12:00 |
|---|---|---|---|---|
| 60× | 1 min | 710 (window ending 12:49:30) | 556 | 384 |
| 600× | 10 min | 6,818 (12:57) | 5,684 | 4,352 |
| 3600× | 60 min | 38,472 (13:10) | 34,927 | 29,181 |

Against the 500 cap: 60× exceeds it in the median minute of the peak; 600× by 11–14×; 3600× by 60–77×.

### Amazonas, playhead 2026-10-31 00:30:00Z (the night storm)

Ring 222,356 (whole replay, 12:59:59Z to 03:57:39Z): GLM-East 155,303 + MTG LI 67,053, so pairs within 400 ms / 0.15° are drawn twice (both glows, one channel, per `docs/flash-profile.md`). Radius p5/p50/p95 = 4.7 / 10.4 / 22.9 km (GLM pixels are larger); duration 2 / 212 / 766 ms; intensity 0.26 / 0.51 / 0.80; duration shares 28 / 36 / 26 / 10 %. Rate 00:00–01:00: 68–147/min, mean 108; last minute before 00:30: 102; per wall second max over the night: 298 (23:08) at 60×, 2,742 at 600×, 13,380 at 3600× (window ending 00:00). Densest point at 00:30: −7.40, −64.00 (62 km from the track point used); 13.7 % within 10 km, 28 % within 25 km, 47 % within 50 km of it. The 02:00 scene (18–27 flashes/wall second at 60×) is a dying storm, useful as the "few flashes at night" case.

## 4. Channel geometry today, measured on the skeletons

2,000 seeds per kind, radii drawn from the Basse-Kotto percentiles, `channelSkeleton()` of `web/src/globe/lightning/skeleton.ts`, length-weighted share of segment length by angle from the horizontal (< 20° horizontal, 20–60° oblique, > 60° vertical); "on screen" projects the vertical component by sin(tilt) and the horizontal one by the azimuth average (1 + cos tilt) / 2.

| | In-cloud (75 % of flashes) | Ground (25 %) |
|---|---|---|
| 3D: horizontal / oblique / vertical | **96.3 / 3.7 / 0 %** | 31.7 / 48.5 / 19.8 % |
| Length below the 7 km cloud base (veiled by `(1 − opacity)²`, < 1 % through a thick storm) | 0 % | **66.1 %** |
| On screen at the storm frame (tilt 20°) | 100 / 0 / 0 % | 73.2 / 25.3 / 1.5 % |
| On screen at the oblique pose (tilt 45°) | 98.3 / 1.7 / 0 % | 37.9 / 48.8 / 13.3 % |
| On screen at iss (tilt 1°) | 100 / 0 / 0 % | 100 / 0 / 0 % |
| Heights | 8.0–11.5 km | 0–12.4 km |
| Max horizontal reach from the position | 38.8 km (2.2 r + bends) | 21.2 km |
| Flashes whose channel touches the ground | 0 % | 100 % (but hidden by the cloud) |

Weighted by the 25 % share: about **5 % of all channel length is steeper than 60° in 3D, 0.4 % on screen at the default framing**, and two thirds of the ground channels' length is under the cloud base where the veil removes it. That is the measured cause of "flashes are too horizontal": nothing on screen is vertical, by construction (`horizontal = true` flattens in-cloud offsets, `v[2] *= 0.3`, heights clamped 8–11.5 km) and by foreshortening (tilt 20° shows 34 % of a vertical length), and the ground drop reaches the ground within 20 ms (one frame) so no descent is ever seen.

## 5. What the pictures show

Thirty frames and nine crops were looked at. The most telling ones:

| File (`captures/baseline/…`) | Scene | What it shows |
|---|---|---|
| `2026-10-27-basse-kotto/1200-60-oblique-1.png` + `crops/1200-60-oblique-1-cell.png` | noon, 60×, oblique | ~45 white squiggles lying flat on a white deck, "worms"; every one horizontal; a few long thin crawlers; no vertical, nothing reaches the ground; channels bleached white on white |
| `2026-10-27-basse-kotto/1200-60-iss-1.png` | noon, 60×, straight down | same squiggles from above, soft round glows (1–2 r) beneath each, cloud deck pale blue-white |
| `2026-10-27-basse-kotto/1200-60-window-1.png` + crop | noon, 60×, horizon view | cluster of flat squiggles in a dashed ellipse, one bright patch (cloud light) where they overlap; horizon and limb are beautiful |
| `2026-10-27-basse-kotto/1200-600-oblique-1.png`, `1200-600-iss-1.png` + `crops/1200-600-iss-1-cell.png` | noon, 600× | the "lit Christmas tree": 30–40 short fat **stubs** (commas) because each flash is cut after its first pulse by the 500 cap (`channelReveal` never completes), over a whitened deck; nothing reads as a flash |
| `2026-10-27-basse-kotto/1200-600-window-1.png` | noon, 600×, horizon | column of stubs along the convective line (the "wave" the maintainer likes, here as a line of blips) plus one huge round glow at left reading as a UFO |
| `2026-10-27-basse-kotto/1200-3600-oblique-1.png` + `crops/1200-3600-oblique-1-cell.png`, `1200-3600-window-1.png` | noon, 3600× | **no channel at all**, a field of 40–80 px soft white discs (polka dots) along the line: "a light bulb that moves" |
| `2026-10-27-basse-kotto/1530-60-oblique-1.png` + `crops/1530-60-oblique-1-cell.png` | 15:32, sun 20°, 60× | the best daytime frame: blue-white dendritic networks with soft halos over a blue-grey deck, ~12 flashes readable, bleached knot where 3–4 overlap |
| `2026-10-27-basse-kotto/1530-600-window-1.png`, `1530-600-oblique-1.png` | 15:50, 600× | five or six "cotton balls": each cell a white patch with 10–30 overlapping stubs; the cells are separate (good), nothing inside them is |
| `2026-10-27-basse-kotto/1530-3600-iss-1.png`, `1530-3600-oblique-1.png` | 16:45–16:56 (night), 3600× | one over-exposed white blob with a fringe of channel hairs, the second cell a grey disc; the cell has left the frame at iss |
| `2026-10-27-basse-kotto/1645-60-oblique-1.png` | twilight, 60×, 36–55 flashes/min | compact dendritic cluster in a round white glow: already a "ball" at 60× when the cell is compact; warm brown-grey deck is lovely |
| `2026-10-27-basse-kotto/1645-600-oblique-1.png` + crop | twilight, 600× | the textbook ball: ~30 dendritic channels tangled on a saturated round glow |
| `2026-10-27-basse-kotto/1730-60-oblique-1.png` + crop, `1730-60-iss-2.png` | night, weak, 60× | 2–3 flashes, fully readable, one long crawler, one tree; the cloud light is a soft round grey lamp; at iss three plainly circular discs with a short channel each |
| `2026-10-30-amazonas-140/0030-60-oblique-1.png` + `crops/am-0030-60-oblique-1-cell.png`, `0030-60-iss-1.png` | night, 100/min, 60× | the best night frame: ~15 readable dendrites over a bank of soft round discs; the discs are visibly circular and tiled ("lamp array"); the core where 4–5 overlap is bleached |
| `2026-10-30-amazonas-140/0030-600-oblique-1.png`, `0030-3600-oblique-1.png` | night, 600× / 3600× | hundreds of tangled channels on a continuous white glow (white 8–10 %), then a bloated white mass (white 17 %) |
| `2026-10-18-minas-gerais-7/2315-60-oblique-1.png` + `crops/mg-2315-60-oblique-1-cell.png`, `2315-600-oblique-1.png` | R1 night, 60× / 600× | 60×: several cells, ~10–15 readable dendrites, cores bleached, city lights; 600×: cotton balls with tangles, nothing individual |

Against the maintainer's complaints:

1. **Channels are horizontal: confirmed, totally.** In every frame at every pose the channels lie in the cloud-top plane. Nothing reads as vertical, oblique or as hitting the ground, by day or night, at 60× or 600×. Measured in §4: 0.4 % of on-screen channel length is steeper than 60° at the default framing. The ground looks (25 %) are invisible: two thirds of their length is under the cloud base and veiled, their descent takes one frame, and they are dark between strokes.
2. **Ball of lightning: confirmed at 600× and 3600×, and at 60× on compact cells.** At 60× on the wide noon system the flashes spread over the line (no ball, `1200-60-*`); on the compact twilight cell (`1645-60-oblique`) and in the R1 and Amazonas cores, 3–5 overlapping dendrites plus their glows and the max-blended cloud light bleach a round 100–200 px knot. At 600× every cell is a round white patch with a tangle; at 3600× only round discs remain (day) or one saturated blob (night). The data say the cell is not a point (8 % of the busiest minute within 10 km): the ball comes from (a) the round glow (1–2 r, 32–67 px at iss) drawn under every flash, (b) the cloud light splat (2 r disc, no structure), (c) screen/max blending of 500 of them in one place.
3. **Individual flashes.** Readable at 60× when under ~50 are lit and spread (noon: ~45 squiggles; 15:32: ~12; night Amazonas: ~15; R1: 10–15; twilight compact cell: a cluster of 6–8 with 1–2 readable). At 600×: 0 in the cores, 30–40 stubs around; at 3600×: 0.
4. **600× vs 3600×.** 600× keeps channel stubs and a line of separate cells (the "wave": `1200-600-window`, `1530-600-window`); 3600× loses channels entirely by day (glow discs only) and at night becomes one bloated blob. The difference exists but neither reads as lightning.
5. **Day vs night.** By day the channels are drawn white (core `#eef2ff`, additive, `CHANNEL.dayLevel` 0.3) on a deck that is already near white at noon: contrast is low, channels read as bleached worms, and the lit cloud disc is barely visible (`1200-600-whole`: a white patch inside white). At 15:30 (sun 20°) the deck turns blue-grey and the look becomes good. At night the channels, halos and lit discs read clearly on the dark deck; the discs then read as round lamps.
6. **Density.** At 60× the noon frames carry 500–600 flashes per wall second: "almost a bit too heavy" is the data rate of a level-5 storm plus a 1 s life for every flash; the cap already truncates 10–15 % of them.

What is beautiful and must be kept:

- The dendritic in-cloud networks at 60× when isolated: tortuous trunks, uneven branching down to hairlines, soft blue halo, bright core (`1530-60-oblique`, Amazonas and R1 at 60×). Their shape quality is right; their orientation and their numbers are the problem.
- The late-afternoon and twilight decks (blue-grey at 15:30, warm brown-grey at 16:45) and the night cloud lit from inside at 60× with few flashes (`1730-60-oblique`): contemplative, photographic.
- The separation of cells along the line at 600× (`1530-600-window`, `1200-600-window`): the front advancing as a wave.
- The horizon views (`window`) with the limb, and the whole-storm frame at 60× by day where the lightning is a cluster of small bright marks on the shield.
- The flicker and pulse timing (not visible in stills; `docs/flash-profile.md`).

Rendering artefacts seen (clouds out of scope but noted):

- **Beaded channels**: on thin long branches at night the ribbon segments show as a chain of dots (`crops/mg-2315-60-oblique-1-cell.png`, `crops/1730-60-oblique-1-cell.png`): the half-width overlap at joints does not hide the joints on hairlines.
- **Round discs**: the cloud light (2 r disc, 4.7 km texels) and the near-floor glow give circular, tiled lamps at night at iss and oblique (`1730-60-iss-2`, `0030-60-iss-1`).
- **Stubs** at 600×: channels cut after the first pulse by the 500-flash budget (`1200-600-iss`).
- **Lone giant glow**: a large-area flash from afar draws a soft 150 px disc that reads as a UFO (`1200-600-window-1`, left).
- **Day bleaching**: white channels over a white deck; `white` metric reaches 13–31 % at iss at 600×/3600× by day.
- **Clouds**: the deck is soft (1 km texels at 0.23–0.3 km/px); fine for this study. The relief clouds do not show channel-cloud interaction (no channel appears to pierce or light a column).
- Capture protocol, not rendering: at 3600× the storm leaves the frame in 2 s of wall time; `Position observed … 47 min earlier` is just the HUD in Paris time.

## 6. Baseline numbers for acceptance criteria

Numbers the tickets can be measured against (same tool, same scenes, §7):

| Measure | Baseline today | Where |
|---|---|---|
| On-screen channel length steeper than 60° (default frame, tilt 20°) | 0.4 % (in-cloud 0 %, ground 1.5 %) | `skeleton-stats.json` |
| Channel length under the cloud base (hidden) | ground 66 %, in-cloud 0 % | same |
| Flashes with a channel reaching the ground and visible | 0 | same + veil |
| Flashes started per wall second at the Basse-Kotto peak | 60×: 384–710; 600×: 4,352–6,818; 3600×: 29,181–38,472 | `stats-basse-kotto-1200.json` |
| Flashes with a visible channel at once (noon, oblique) | 60×: ~45; 600×: 30–40 stubs; 3600×: 0 | frames |
| Individually readable flashes in the densest cell | 60×: 1–2 of 6–8 (compact cell), 10–15 (spread); 600×: 0; 3600×: 0 | frames |
| Near-white pixels at night (central region) | 60×: 0.0–1.7 %; 600×: 1.7–27.6 %; 3600×: 8.8–36 % | table |
| Near-white by day at iss, noon | 60×: 1.6–2.6 %; 600×: 5–13 %; 3600×: 2.5–31 % | table |
| Lit share at night, Amazonas oblique | 60×: 13–16 %; 600×: 37–40 %; 3600×: 15–49 % | table |
| Lit blobs at night, Amazonas oblique | 60×: 2,600–3,100; 600×: 6,500–6,800; 3600×: 2,700–8,100 | table |
| Share of the busiest minute within 10 / 25 / 50 km of the densest point | 8 / 11 / 40 % (data; the picture shows one point) | stats |

Suggested targets for the tickets (to confirm with the maintainer): on-screen channel length steeper than 60° ≥ 30 % at tilt 45° and ≥ 15 % at the default framing, with ≥ 20 % of channels visibly reaching the ground when not under an opaque cloud; at 600× ≤ 60 flashes with a channel at once and ≤ 2 % near-white at night; at 3600× ≤ 25 channels and still ≤ 2 % near-white, with a visible difference from 600× (channel count or glow extent); at 60× every flash in a compact cell separable from its neighbours by ≥ 1 r on screen or by time. The capture tool should gain a `--no-clouds` option (`localStorage scintille.clouds.visible = 0`) so that `white`/`lit`/`blobs` measure the lightning alone by day.

## 7. Capture matrix after the changes

Same tool, same options (`--frames 4 --gap 700 --settle 12`, `--play-before 500` at 3600×), aimed at the densest points:

```
--storm 2026-10-27-basse-kotto --time 2026-10-27T12:00:00Z --speed 60    (whole)
--storm 2026-10-27-basse-kotto --time 2026-10-27T12:00:00Z --speed 60   --view 4.3,19.9,500,45
--storm 2026-10-27-basse-kotto --time 2026-10-27T12:00:00Z --speed 60   --view 4.3,19.9,400,1
--storm 2026-10-27-basse-kotto --time 2026-10-27T12:00:00Z --speed 60   --view 4.9,19.9,740,60,200
--storm 2026-10-27-basse-kotto --time 2026-10-27T12:00:00Z --speed 600  --view 4.3,19.9,500,45
--storm 2026-10-27-basse-kotto --time 2026-10-27T12:00:00Z --speed 600  --view 4.3,19.9,400,1
--storm 2026-10-27-basse-kotto --time 2026-10-27T12:00:00Z --speed 600  --view 4.9,19.9,740,60,200
--storm 2026-10-27-basse-kotto --time 2026-10-27T12:00:00Z --speed 3600 --view 4.3,19.9,500,45 --play-before 500
--storm 2026-10-27-basse-kotto --time 2026-10-27T12:00:00Z --speed 3600 --view 4.3,19.9,400,1 --play-before 500
--storm 2026-10-27-basse-kotto --time 2026-10-27T15:30:00Z --speed 60   --view 2.872,18.141,500,45
--storm 2026-10-27-basse-kotto --time 2026-10-27T15:30:00Z --speed 600  --view 3.472,18.141,740,60,200
--storm 2026-10-27-basse-kotto --time 2026-10-27T16:45:00Z --speed 60   --view 3.601,17.158,500,45
--storm 2026-10-27-basse-kotto --time 2026-10-27T16:45:00Z --speed 600  --view 3.601,17.158,500,45
--storm 2026-10-27-basse-kotto --time 2026-10-27T17:30:00Z --speed 60   --view 3.441,16.740,500,45
--storm 2026-10-27-basse-kotto --time 2026-10-27T17:30:00Z --speed 60   --view 3.441,16.740,400,1
--storm 2026-10-30-amazonas-140 --time 2026-10-31T00:30:00Z --speed 60   --view=-7.4,-64.0,500,45
--storm 2026-10-30-amazonas-140 --time 2026-10-31T00:30:00Z --speed 60   --view=-7.4,-64.0,400,1
--storm 2026-10-30-amazonas-140 --time 2026-10-31T00:30:00Z --speed 600  --view=-7.4,-64.0,500,45
--storm 2026-10-30-amazonas-140 --time 2026-10-31T00:30:00Z --speed 3600 --view=-7.4,-64.0,500,45 --play-before 500
--storm 2026-10-18-minas-gerais-7 --time 2026-10-18T23:15:00Z --speed 60  --view=-14.56,-44.26,500,45
--storm 2026-10-18-minas-gerais-7 --time 2026-10-18T23:15:00Z --speed 600 --view=-14.56,-44.26,500,45
```

Plus the skeleton statistics test (`tools/skeleton-stats.test.ts`) for the orientation shares and `web/scripts/bench.mjs --storm R1 --speed 600` for frame cost and GPU memory (ADR 0020 budgets).
