# Methodology

## Flash brightness and size

Each flash in the live feed carries `intensity`, a value in [0, 1] that stands for the optical energy
the satellite measured, brought to a common scale across instruments. The normalization from raw
energy to `intensity` is done upstream, on the data side, and is defined in #33 (log transform and
per-source percentile mapping). Until #33 lands, the feed uses a provisional log-energy mapping (see
[hot-path.md](hot-path.md)). The globe only relies on the [0, 1] contract, so a recalibration
upstream needs no change here.

The globe turns `intensity` into two visual cues, in
[`web/src/globe/lightning/intensity.ts`](../web/src/globe/lightning/intensity.ts):

| Cue | Mapping | Range |
|---|---|---|
| Brightness (linear light) | `0.08 + 0.92 × intensity^2.2` | 0.08 to 1 |
| Glow radius multiplier | `0.6 + 0.8 × intensity` | 0.6 to 1.4 |

**Brightness.** The renderer works in linear light and encodes its output to sRGB, which is close to
a 1/2.2 power. Raising `intensity` to the power 2.2 undoes that encoding, so the value that reaches
the screen grows linearly with `intensity`, and sRGB is built so that equal steps of encoded value
look like roughly equal steps of brightness. A flash twice as far up the intensity scale therefore
looks about twice as far up the brightness scale. The floor of 0.08 keeps the weakest flashes
visible: an empty spot must mean "no detection", never "too faint to draw".

**Size.** The glow radius (already set by the measured flash area, with a minimum on-screen size)
is multiplied by a factor that grows linearly with `intensity`. The area of the glow, which is what
the eye compares, then grows faster than linearly, which helps strong flashes stand out without
making weak ones vanish.

Both cues multiply the time profile of the flash ([flash-profile.md](flash-profile.md)). The same
brightness mapping also drives the glow that flashes cast inside the clouds.

**Limits.** Brightness on screen is relative: it depends on the device, the bloom pass and how many
flashes overlap. It shows which flashes are stronger, not absolute energy values. The legend in the
HUD is drawn from the same functions as the globe.
