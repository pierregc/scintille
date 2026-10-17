# Replay framing calibration (#83)

Updated 2026-10-17. **Visual calibration and maintainer acceptance are pending.**
The current configuration remains the initial #79 proposal: 12° tilt, 2.8 s flight, 62% central
viewport, 300 km minimum requested range. No visual tuning was inferred from unit tests.

## Reproduce

Use the #83 Preview at 1440×810 and 390×693 CSS pixels, then repeat at the device's native size.
Open `/?storm=<slug>&speed=60`. For a fixed moment, add `&paused=1&time=<UTC instant>`.
Use high and low quality; also test reduced motion, interrupt with mouse/touch/wheel, enable clouds,
play through the track and scrub backwards. Capture the whole viewport including controls.

These five cases are **synthetic QA data**, explicitly labelled in the catalog, not measurements
of those geographic storms. The antimeridian case is a geometric stress case outside the active
lightning coverage. Source IDs in synthetic chunks exercise decoding only; they claim no detection.
The Preview build generates the additional extracts from
`web/src/globe/replay/framing-cases.json` through the existing SCNT fixture encoder. Production
builds omit all fixture files. Requests for a QA slug select the fixture data root for that session.

| Fixture slug | Start UTC | Target lat, lon | Desktop range km | Portrait range km | Purpose |
| --- | --- | --- | --- | --- | --- |
| `2026-07-15-orlando` | 2026-07-15 18:00:01 | 28.5, -81.3 | 306.000 | 306.000 | Small, coastal, day; existing real-contract synthetic fixture |
| `qa-large-inland-night` | 2026-07-16 06:00:00 | 34, -94 | 6924.340 | 11928.677 | Large inland extent at night |
| `qa-offshore-day` | 2026-07-15 15:00:00 | 12, -36 | 2103.818 | 3657.004 | Offshore daytime context |
| `qa-dateline-day` | 2026-07-15 00:00:00 | 0, -180 | 2952.968 | 5125.035 | Wrapped bounds and short-arc trajectory |
| `qa-south-coast-night` | 2026-07-16 03:00:00 | -29.5, -49.5 | 1179.216 | 2053.277 | Southern coastal night |

Ranges are the framing outputs at FOV 35°, aspects 16:9 and 9:16. Automated checks now also
confirm these destination ranges and tilts after the real control safety limits and flight handoff.
Tilt is 12° and duration 2800 ms for each pose. Controls retain reduced-motion instant arrival and
their existing altitude/tilt safety limits.

Only the Orlando observation time has a cloud fixture; other times can legitimately show no
historical cloud data. Do not replace missing observations with live imagery to make a capture.

## Evidence and decision

| Check | Evidence / status |
| --- | --- |
| Production loader reads generated chunk references and counts | Automated `framing-cases.test.ts` |
| Synthetic flash positions follow the advertised multi-step tracks | Automated decoded-coordinate comparison |
| Final camera range/tilt and full extent/track inside the central viewport at both aspects | Automated with real controls, flight handoff and production clip planes; table above records outputs |
| Arrival at 2800 ms, pointer/wheel interruption and first-update reduced-motion arrival | Automated with a controlled clock; device timing and touch remain unmeasured |
| Lighting day/night and cloud compositing | Pending desktop/touch captures |
| Whole lightning extent and revealed trajectory stay readable, controls unobscured | Pending desktop/touch captures |
| Smooth interruptible flight, no excessive tilt, reduced motion | Pending runtime capture |
| Five representative **real published storms** | Pending catalog/production verification #74 |
| Maintainer visual decision on all five real examples | Pending; synthetic exercises do not satisfy this criterion |

For each runtime capture record Preview commit, slug, UTC playhead, viewport/DPR, quality,
cloud state, device/browser and reduced-motion state. For entry timing record data-ready to
camera-settled separately from navigation to data-ready, downloaded bytes and network conditions.
Attach captures to #83, replace/augment synthetic examples with five actual catalog slugs, then
record the chosen configuration or a small correction PR before accepting #83.

## Synthetic density

Each non-Orlando extract holds 480 flashes over 45 scene minutes, scattered around the track
with a rise and decay in rate (peak about 20 per minute), so about 45 seconds of playback at 60×.
Generation is seeded per slug and reproducible. Orlando keeps its existing 3-flash contract
fixture, shared with other tests. Density remains synthetic and says nothing about real storms.

## Status

Feature PRs #264 to #267 and the reload fix #273 are merged. The tests exercise the real
camera/control path for all ten fixture/aspect pairs, projecting the full geographic boxes and
every trajectory vertex after arrival, plus interrupted flights and reduced motion. They do not
render lightning, overlay controls, clouds or audio, and cannot establish touch behavior or
visual approval. Keep the proposed 12° / 2800 ms configuration until the required observations
support a maintainer decision.

Real catalog slugs are still unavailable: the public catalog index returns 404 (#74/#269). The
Dagster run-submission defect #271 is fixed by #274; production bootstrap remains to be run.
