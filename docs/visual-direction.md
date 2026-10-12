# Visual direction

What an astronaut sees from the International Space Station at night: a dark planet lit by the Sun as it
really is, city lights, the thin blue line of the atmosphere, and storms flickering inside the clouds.
Photographic, soft, realistic light and colour. Never cartoon, never neon, never a dashboard.

The interface is direction **A2, "ethereal instrument"**: a quiet instrument floating over the view. Type
and hairlines sit directly on the Earth, with no panels, no frames and no frosted glass. The reference
mockup is [`visual-direction/a2-ethereal.html`](visual-direction/a2-ethereal.html) (open it in a browser;
`?mode=replay` and `?info=1` show the other states).

## Principles

- **The globe is the content.** The HUD never hides more than the corners and a thin bottom strip.
- **Light, not chrome.** No boxes, no fills, no blur. Legibility comes from a soft text shadow, not from a
  background.
- **One strong element.** The UTC clock is the only large piece of type; everything else is small caps.
- **Live is a breath.** The live state is a slow white pulse. No red, no "LIVE" badge.
- **Warmth is rare.** The pale cream accent marks only the playhead and the main call to action.
- **Motion is slow.** Transitions of about 0.6 s, eased; nothing bounces. `prefers-reduced-motion` turns
  pulses and transitions off.

## Palette

| Token | Value | Use |
|---|---|---|
| `space` | `#000000` | Page background behind the globe |
| `ink` | `#EEF2F7` at 90 % | Primary text, clock, active controls |
| `soft` | `#EEF2F7` at 62 % | Secondary text, idle controls, body copy |
| `dim` | `#EEF2F7` at 40 % | Captions, inactive options, labels |
| `hair` | `#EEF2F7` at 14 % | Hairlines, ticks, underlines, corner marks |
| `glow` | `#F3E7CC` | Accent: playhead, "Drift to a storm" |
| `shade` | `#000000` at 55 % | Text shadow (`0 0 14px`) that keeps type readable on bright clouds |
| `flash` | `#E4EBFF` | Lightning core: blue-white, as seen through cloud tops |
| `pulse` | `#FFFFFF` | Live indicator, with a white glow |

The Earth itself takes its colours from NASA imagery (Blue Marble, Black Marble), not from this palette.
Lightning stays blue-white; its intensity comes from measured energy, and any warmth only from the cloud it
lights, never from a colour scale.

## Typography

- **IBM Plex Sans** (200, 300): name, body copy, the lead sentence. Body 14 px / 1.6–1.75, weight 300.
- **IBM Plex Mono** (200, 300): clock, dates, controls, captions. Tabular figures for every number.
- Clock: Mono 200, 40 px (26 px on phones), letter spacing 0.04 em.
- Captions and controls: Mono 300, 10–11 px, uppercase, letter spacing 0.14–0.24 em.
- Name: Sans 200, 18 px, uppercase, letter spacing 0.5 em.
- Only light weights; nothing heavier than 400.

## Density

Minimal. Visible by default:

- top left: the name and an "i" that opens the about text over a soft left gradient (bottom sheet on phones);
- top right: the UTC clock, date and live/replay state, then two layer switches (Clouds, Sound) and the
  afterglow choice (how long a flash stays on screen);
- bottom: time controls on the left, the replay timeline in the middle, the storm call to action on the right;
- four faint corner marks.

No counter, no histogram, no legend, no map controls for now. The indexable home text stays in the HTML,
inside the about sheet.

## Defaults to tune later

These come from the mockup and are expected to change after real use:

- Call to action: **"Drift to a storm"**; time travel entry: **"Travel in time"**.
- Playback speeds: **1×, 60×, 600×, 3600×**, 60× by default. Flash display and flicker are timed in scene
  time, so at 60× and above a flash lasts a frame or two; they need wall-time (or speed-scaled) timing before
  60× ships as the default.
- Afterglow: **0, 1, 5, 30 minutes**, 5 by default; 0 shows the flash alone for 3 s.
- Timeline: one UTC day, ticks every 30 minutes, labels every 6 hours.
- No flash counter and no activity histogram.

## References

1. [Gateway to Astronaut Photography of Earth](https://eol.jsc.nasa.gov/) (NASA JSC): night photographs from
   the ISS, the target for colour, darkness and the look of lightning inside clouds.
2. [NASA Black Marble](https://blackmarble.gsfc.nasa.gov/): the reference for city lights and the night
   side.
3. [NASA Scientific Visualization Studio](https://svs.gsfc.nasa.gov/): restrained, photographic data
   visualisation on a realistic globe.
4. [earth.nullschool.net](https://earth.nullschool.net/): data first, almost no UI, a single discreet menu.
5. [NOAA GOES-R GLM](https://www.goes-r.gov/spacesegment/glm.html): what the instrument actually sees,
   flashes as pulses of light on cloud tops.
6. Galaxy collision simulators: slow, contemplative motion of points of light, where time controls are part
   of the experience.
7. [IBM Plex](https://www.ibm.com/plex/): the typeface family, chosen for its thin weights and technical tone.

Counter-examples: neon lightning maps with dense legends, and weather apps with stacked panels. Scintille
should feel like a window, not a control room.
