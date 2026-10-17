# M3 discovery and replay acceptance (#261)

Prepared 2026-10-17. **M3 is not accepted by this document.** No PR in the stack below has been
merged by the agent. Unit/build evidence and synthetic Preview exercises are separate from runtime,
production and maintainer acceptance.

## Review order and delivered work

| Ticket | PR / dependency | Available evidence |
| --- | --- | --- |
| #260 | [#263, merged by maintainer](https://github.com/pierregc/scintille/pull/263) | Historical cloud indices, bounded downloads, cancellation/cache tests |
| #79 | [#264](https://github.com/pierregc/scintille/pull/264), base main | Production replay entry, atomic scene replacement and geographic framing |
| #80 | [#265](https://github.com/pierregc/scintille/pull/265), base #264 | Observed trajectory growth/rewind, spherical paths and disposal |
| #81 | [#266](https://github.com/pierregc/scintille/pull/266), base #265 | Bounded catalog suggestions and useful error/empty/stale states |
| #82 | [#267](https://github.com/pierregc/scintille/pull/267), base #266 | UTC moment/view share links, navigation, validation and clipboard fallback |
| #83 | [#268, draft](https://github.com/pierregc/scintille/pull/268), base #267 | [Five reproducible synthetic framing cases](replay-framing.md); real-storm/visual acceptance pending |
| #74 | [#269, draft](https://github.com/pierregc/scintille/pull/269), base main | Production prerequisite/freshness evidence checklist; actual deployment checks pending |

Review/merge the feature stack from its base upward and retarget each dependent PR after the
previous base merges. #269 is independent. This document and the integration PR depend on #268.

The four ready feature PRs have passing CI and Preview builds. Their web test totals progress
388 → 394 → 401 → 414. The calibration preparation has 416 passing local web tests, type/lint
checks and a passing Preview build. Those totals do not prove frame rate, perceived flight quality,
physical GPU release, audio output or production availability. This session has no browser backend;
local builds cannot complete the Cloudflare inspector socket under the sandbox, while hosted builds
can. The public data endpoint could not be resolved from this environment.

## Decisions to record

- ADR 0011: accept the explicit track-bounds approximation and separate replay/classification
  counts, or propose a concrete amendment. #266 exposes classified metrics and the approximation
  note. Historical cloud discovery is no longer an upstream gap; the proposed text now points to 0014.
- The duplicate proposed replay ADR 0013 is renumbered to [0017](../adr/0017-replay-feed-lifecycle.md).
  The lightning-ribbons ADR keeps 0013. Recommend reviewing the shared scene-owner decision against
  the runtime resource checks below before marking it accepted.
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
| Navigation | Initial URL, same/different storm, back/forward, rapid changes, failed replacement, Back to live |
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
- [ ] Any remaining runtime defect has its own small blocking ticket, with reproduction and evidence.
- [ ] Maintainer accepts the dated evidence before closing M3.

No runtime defect is invented merely because a check could not be executed here. Add a defect ticket
when an actual failure is observed. M5 imagery tiles, realistic close-view lightning scale, grazing
descent and continuous live cell following remain outside M3 acceptance.
