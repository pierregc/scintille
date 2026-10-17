# M3 discovery and replay acceptance (#261)

Updated 2026-10-17. **M3 is not accepted by this document.** Feature PRs #264–#267 have been
merged by the maintainer, including the close zero-tilt restoration fix in #267. Unit/build evidence
and synthetic Preview exercises are separate from runtime, production and maintainer acceptance.

## Review order and delivered work

| Ticket | PR / dependency | Available evidence |
| --- | --- | --- |
| #260 | [#263, merged by maintainer](https://github.com/pierregc/scintille/pull/263) | Historical cloud indices, bounded downloads, cancellation/cache tests |
| #79 | [#264](https://github.com/pierregc/scintille/pull/264), merged into main | Production replay entry, atomic scene replacement and geographic framing |
| #80 | [#265](https://github.com/pierregc/scintille/pull/265), merged into main | Observed trajectory growth/rewind, spherical paths and disposal |
| #81 | [#266](https://github.com/pierregc/scintille/pull/266), merged into main | Bounded catalog suggestions and useful error/empty/stale states |
| #82 | [#267](https://github.com/pierregc/scintille/pull/267), merged into main | UTC moment/view share links, navigation, clipboard fallback and zero-tilt range restoration |
| #83 | [#268, draft](https://github.com/pierregc/scintille/pull/268), base main | [Five reproducible synthetic framing cases](replay-framing.md); real-storm/visual acceptance pending |
| #74 | [#269, draft](https://github.com/pierregc/scintille/pull/269), base main | Production prerequisite/freshness evidence checklist; actual deployment checks pending |

The feature stack is merged. #268 now targets main; this integration PR still depends on #268.
#269 is independent. Retarget the integration PR to main after #268 merges.

The original feature heads had passing CI and Preview builds. Their web test totals progressed
388 → 394 → 401 → 414. The #267 follow-up passed 416 local tests, including real-controls
share/history restoration of a dragged zero-tilt surface view at desktop and portrait aspects.
The original calibration head had 416 passing local web tests, type/lint checks and a passing
Preview build. Its follow-up adds final-camera extent/track projections for all five fixtures at
both aspects, pointer/wheel interruption and reduced-motion arrival using real controls.
After rebase on current main including the #267 fix, that follow-up passes 432 tests, Astro check,
ESLint, a complete production build and SEO checks on the calibration branch. Those results do not prove
frame rate, perceived flight quality, physical GPU release, audio output or production availability. This session has no browser backend;
the complete local build succeeded after allowing Wrangler registry writes outside the sandbox.
SSH and public HTTP observations are recorded below.

## Production and browser observations on 2026-10-17

The resumed session reached the VPS over pinned-host SSH at 08:40–08:45 UTC. The running pipeline
release is `880df68`, before the catalog exporter. It has no publication module/job/schedule;
`gold` has no tables. Silver has data, but that does not establish usable per-cell minute counts,
ordered tracks or persisted levels. The required public index returns HTTP 404.

Dagster has 256 `NOT_STARTED` runs and no successful executions. Recent sensor/schedule ticks fail
on parameterized PostgreSQL `NOTIFY` during asset-planned event storage. This reproduced defect is
tracked in [#271](https://github.com/pierregc/scintille/issues/271) and blocks production prerequisite
materialization. Full release, driver, run-ID and inventory evidence is recorded in
[the #74 production acceptance packet](https://github.com/pierregc/scintille/pull/269).
No deployment, schedule activation, run cancellation or table write was performed. Recover the
execution defect, deploy a validated current release and materialize/publish in dependency order
before claiming actual catalog examples, reference integrity or measured freshness.

The browser backend was retried and still reported no available browser. Desktop/touch captures,
clipboard/focus, GPU/audio and device timing remain unobserved. Earlier sandbox access failures
are superseded by successful SSH/HTTP reads, not by successful production acceptance.

## Decisions to record

- ADR 0011: accept the explicit track-bounds approximation and separate replay/classification
  counts, or propose a concrete amendment. #266 exposes classified metrics and the approximation
  note. Historical cloud discovery is implemented by #260 ([0014](../adr/0014-historical-cloud-discovery.md));
  ADR 0011 retains its original historical statement unchanged.
- Keep both historical 0013 proposals unchanged and identify them by full filename:
  [replay feed lifecycle](../adr/0013-replay-feed-lifecycle.md) and
  [3D lightning ribbons](../adr/0013-3d-lightning-ribbons.md).
  [0017](../adr/0017-preserve-adr-history.md) records the duplicate resolution and amendment policy.
  Review the shared scene-owner proposal against runtime resource evidence; no acceptance is inferred.
- ADRs 0015 and 0016 remain proposals for entry/support limits and the URL subset. In particular,
  sharing preserves target/range/tilt and normalizes local heading/roll; accept or amend that subset.
- #41 was closed after the retention collector PR #262 merged. Preserve that decision. Its
  implementation closure does not establish the production measurements/budget/retention decisions
  still listed in [the retention evidence checklist](../retention.md#evidence-and-decisions-needed-for-41).
  Record the maintainer's acceptance or remaining measurement work without silently reopening #41.

## Runtime acceptance matrix

Choose five **actual published** catalog storms from #74, with IDs, playhead times and viewports
recorded: large/small, day/night, coastal/offshore and a difficult geographic boundary. The
synthetic #83 set is a reproducible preparatory exercise, not a substitute for those observations.
Repeat on desktop and touch, keyboard only, and with reduced motion. Use this record per example:

| Evidence field | Record |
| --- | --- |
| Build and environment | Preview/production URL, commit, UTC date, browser/OS/device, viewport/DPR, quality |
| Published storm | Slug/ID, classified metrics/rule, start/end, replay selection/count and track times |
| Open | Suggestion selection, loading status, data-ready time, bytes, network/cache conditions |
| Frame | Arrival time after data ready, complete extent/track, tilt, controls and interrupt/reduced-motion capture |
| Playback | Autoplay from requested time after framing, pause/play, every speed, forward/backward seek |
| Clouds/sun | Right UTC sun and historical observation; partial/missing archive stays honestly missing |
| Share | Copy/reopen same supported view and instant; manual-copy field after clipboard denial |
| Navigation | Initial URL, same/different storm, back/forward, rapid changes, failed replacement, Back to live; share/restore a close zero-tilt surface view after a right drag |
| Input | Native card/share controls, focus, touch targets and announcements |
| Result | Capture/video, pass/fail, defect issue, maintainer decision |

Run these failure cases explicitly: invalid/unknown/empty slug, malformed optional URL state,
unavailable detail/chunk, unsupported/oversized metadata or extract, no/partial/expired cloud
coverage, first-page failure, later-page failure and slow or interrupted network. A rejected new
storm preserves the old scene and reports an error; stale asynchronous results must never reappear.

## GPU/audio/resource evidence

1. Establish a settled live baseline on a fixed device/quality; note that initial asset compilation
   and caches can grow during warm-up. Record renderer geometry/texture/program counts and active
   audio contexts/voices using browser tools or a local diagnostic session.
2. Exercise repeated live → storm A → live and A → B transitions, including rapid superseding
   loads, backward seeks and return to live during flight/download. Wait for pending work to settle.
3. Check no flashes from the previous ring generation, old track, historical cloud texture, pending
   thunder or stale selected label remain. Verify live polling restarts and uses wall-clock time.
4. Compare settled resource counts across repeated cycles; attach measurements and investigate
   sustained growth. A unit-test `dispose` spy alone is not evidence that a GPU driver freed memory.
5. Dispose/remount the app (including browser back/forward cache) and verify subscriptions, polling
   and audio lifecycle. Do not claim audio playback from scheduler-only tests.

## Closure checklist

- [ ] ADR decisions/amendments recorded with the duplicate identifier resolved.
- [ ] Five actual catalog examples accepted on desktop/touch, keyboard and reduced motion.
- [ ] Complete suggestions → entry → track → timeline → share → live journey captured.
- [ ] Cold/error paths and partial historical clouds observed.
- [ ] Repeated transition GPU/audio evidence attached and stable.
- [ ] #74 production prerequisites/freshness and #41 retention evidence status explicitly reconciled.
- [x] Confirmed PostgreSQL notification failure has a reproduction/evidence ticket: #271.
- [ ] #271 resolved and successful production recovery observed; any further runtime defect ticketed.
- [ ] Maintainer accepts the dated evidence before closing M3.

No runtime defect is invented merely because a check could not be executed here. Add a defect ticket
when an actual failure is observed. M5 imagery tiles, realistic close-view lightning scale, grazing
descent and continuous live cell following remain outside M3 acceptance.
