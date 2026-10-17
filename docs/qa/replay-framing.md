# Replay framing calibration (#83)

Prepared 2026-10-17. **Visual calibration and maintainer acceptance are pending.**
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

Ranges are the pure framing function outputs at FOV 35°, aspects 16:9 and 9:16, before control
safety limits. Tilt is 12° and duration 2800 ms for each pose. Controls retain reduced-motion
instant arrival and their existing altitude/tilt safety limits.

Only the Orlando observation time has a cloud fixture; other times can legitimately show no
historical cloud data. Do not replace missing observations with live imagery to make a capture.

## Evidence and decision

| Check | Evidence / status |
| --- | --- |
| Production loader reads generated chunk references and counts | Automated `framing-cases.test.ts` |
| Synthetic flash positions follow the advertised multi-step tracks | Automated decoded-coordinate comparison |
| Both aspect ratios yield finite bounded poses | Automated; table above records outputs |
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
