# 0016 · Replay URL state and navigation

- Status: proposed
- Date: 2026-10-17

## Context

#82 shares a selected published storm through the #79 entry. URL changes must reuse that owner
rather than start competing downloads. A shared moment must stay reproducible after loading and
camera travel; clipboard access can fail, especially outside a secure context.

## Options

- Encode only the slug: small, but loses the chosen scene time and view.
- Encode the entire application: fragile, exposes internals and couples URLs to future M5 work.
- Encode a bounded replay subset: stable defaults and explicit validation, with other query keys preserved.

## Decision

Own these query keys on `/`:

| Key | Encoding and default |
| --- | --- |
| `storm` | Published lowercase hyphenated slug, maximum 256 characters; required for replay state |
| `time` | ISO 8601 UTC instant with `Z`, optional milliseconds; defaults to storm start, clamped to its published interval |
| `speed` | Finite number greater than zero and at most 3600; defaults to 60 |
| `paused` | `1` pauses on arrival; otherwise autoplay after camera framing |
| `view` | `lat,lon,rangeKm,tiltDeg`; valid latitude/longitude, range clamped to 20–200,000 km, tilt to 0–80 degrees |

`view` supports a north-up target, range and tilt, matching flyTo. Local heading/roll are normalized
on restoration; arbitrary camera orientation and M5 following modes are outside this contract.
Controls apply their actual aspect-dependent zoom and safety limits. Malformed optional values use
defaults. Invalid/unknown slugs and unavailable extracts retain a usable scene and show an error;
the URL is then canonicalized to the retained scene or live state.

Explicit storm and live actions push browser history. Initial restoration and back/forward use
replace without pushing. Seeks, pause/play and speed changes replace the current entry. Camera
movement is sampled when sharing or writing a replay action, rather than updating history each
render frame. Same-storm navigation reuses loaded data. ReplayNavigation releases its subscriptions
on app disposal and ignores obsolete restoration completion.

Share samples the current valid moment and supported camera state into a paused URL without
pausing the source session. Clipboard failure exposes a selectable read-only link. Query keys such
as quality and debug, and the fragment, survive replay encoding and returning to live.

## Consequences

- Playback is held during entry framing, then starts at the requested instant; short storms are
  not consumed by the camera flight. Reduced motion and user interruption use existing controls.
- Download, clock and camera cancellation remain coordinated through StormReplay/SceneData.
- The existing synthetic Orlando Preview link remains compatible, including custom valid speeds.
- Browser/touch clipboard, back/forward, camera fidelity and focus still need runtime acceptance
  in #261. Round-trip and navigation integration tests do not replace those checks.
