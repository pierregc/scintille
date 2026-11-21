# 0040 · Tropical cyclones from NCEP TC vitals

- Status: accepted
- Date: 2026-11-21

## Context

A hurricane, typhoon or cyclone is the largest storm the globe can show, and visitors look for it.
The maintainer wants one spotted at once, in live and in past days, placed on its clouds and as
light as the rest of the interface (#487, after #290). Tornadoes are out of scope. Infrastructure
must stay free, with no new service.

Checked on 2026-11-21, with cyclone Xavier (04P) active in the South Pacific:

| Source | Coverage | Access and freshness | Verdict |
|---|---|---|---|
| NCEP TC vitals (`gfs.tHHz.syndata.tcvitals.tm00` on NOMADS) | Every basin: NHC, CPHC and JTWC storms in one text file | Keyless, one file per 6 h cycle, about 2 h 40 after the fix time (06Z at 08:41Z), kept 10 days. Position, heading, speed, one-minute wind, 34 kt radii | Adopted |
| IBTrACS v04r01 (NOAA NCEI) | Global, provisional then best track | Keyless CSV, three times a week, about 2 days behind. Provisional tracks come from the same TC vitals | Adopted for the first fill |
| NHC `CurrentStorms.json`, ATCF b-decks | Atlantic, eastern and central Pacific | Keyless, every 3 to 6 h | Not needed |
| JTWC products (`.tcw`, warning text) | Western Pacific, Indian Ocean, southern hemisphere | Keyless, every 6 h, no licence statement found | Not needed: already in TC vitals |
| UCAR RAL combined TC vitals | Global, a year in one file | Keyless | Dropped: 194 duplicated fix times out of 3,570, lines written across two storms |
| GDACS | Global | JSON API | Dropped: redundant |

NWS and NCEP data are in the public domain. TC vitals cut names at 9 characters, which no name on
the current lists exceeds, spell out the number of a storm not named yet, list invests as numbers
90 to 99, and reuse a storm number every season. A file that does not exist yet answers 403.

## Options

- **One feed, written by an hourly Dagster job.** A few small downloads, one JSON object on R2
  rewritten only when it changes.
- **A table in the lake first.** Consistent with lightning, but the whole history is 30 storms and
  about 900 rows for 60 days: a table, its maintenance and a gold model for nothing a file does not
  give.
- **Read the advisories from the browser.** No pipeline, but NOMADS sends no CORS headers and the
  site would depend on a third party at every visit.
- **Show forecast tracks and cones.** Available from NHC and JTWC, but the globe shows what was
  observed, never a forecast.

## Decision

Publish `cyclones/tracks.json` from NCEP TC vitals every hour, and draw each cyclone as a thin
ring placed at the time of the clouds on screen.

- **Pipeline.** `feeds/cyclones` reads the last four cycles at minute 50, merges their fixes into
  the published feed and rewrites it only when a track, a name, an `active` flag or the latest
  cycle changed: about 8 writes a day. The feed is the only state. A fix replaces the one at its
  time; a number silent for more than 5 days starts another storm; a storm leaves 60 days after
  its last fix. A storm is `active` while it has a fix in one of the last two cycles read. A cycle
  with its GFS analysis index but no vitals is a cycle without storms; a run that finds no cycle
  in 24 h fails, and three failed runs in a row alert. `scintille-cyclones --days 10 --ibtracs
  <csv>` fills the days before the first run.
- **Contract.** `CycloneFeed` (2.11.0): storms with `id`, `number`, `name`, `basin`, `agency`,
  `active` and a `track` of fixes. Winds stay in knots as issued, one-minute sustained for every
  basin, so one scale holds worldwide.
- **Position.** Between two fixes, on the great circle, at the time the cloud layer shows, not
  the clock's. Past the last fix of an active storm, along its last heading and speed, 12 h at
  most (a fix is 3 to 9 h old in live); the ring is then drawn fainter. A finished storm ends at
  its last fix. Fixes more than 24 h apart are never joined.
- **Globe.** A ring at the mean radius of 34 kt winds, at least 13 px, with two arms turning the
  way the storm turns, the track of the last 4 days and a name tag: the name, then hurricane,
  typhoon or cyclone by basin (tropical storm under 64 kt, depression under 34 kt) and the wind in
  km/h. The arms are a sign, not data. Depressions are fainter. Pale lines with a soft dark edge,
  so they read on sunlit clouds.
- **Status.** `metrics.json` gains `cyclones`: last check, latest cycle, storms active and kept.

## Consequences

- Cyclones show worldwide, including where no lightning source sees. They are not storms of the
  catalog: no page, search entry, highlight or sound.
- R2: one object of about 110 kB (15 kB gzipped), about 250 writes a month. One short Dagster run
  an hour, in the existing code location.
- The site reads one more file, after the first clouds, every 30 minutes.
- A position between or past fixes is an estimate. On the two storms checked against archived
  clouds (Xavier on 17 November, In-Fa on 27 October) the ring held the eye. The methodology page
  says what the ring is.
- JTWC storms rely on NCEP's file; if it stops carrying them, the western Pacific, the Indian
  Ocean and the southern hemisphere go missing until another source is added. The latest cycle on
  `/status` shows a feed that stopped.
