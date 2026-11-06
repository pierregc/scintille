# 0035 · Lightning inside the clouds

- Status: accepted
- Date: 2026-11-05
- Amends the 10 km cloud shell of [ADR 0028](0028-cloud-relief.md) and the veil of
  [ADR 0033](0033-lightning-looks-and-density.md) (`veil.ts`), under the bounded license of
  [ADR 0030](0030-bounded-aesthetic-license.md)

## Context

Maintainer QA of 2026-11-05 (#426): at the steepest tilt, flashes start in the air above the clouds
and run down through them, as if from nowhere; lightning should start inside the cloud tops and show
through slightly transparent clouds.

The flat cloud layer sat at 10 km, under the channels' tops (11.5 km, 12.5 km for cloud-to-air) and
the round glows (12 km). Where heights are known the channels were kept under the drawn top, the
glows were not. Above all, a channel in a cloud was veiled as if seen from straight above at every
tilt: from a grazing view it was drawn crisp over the cloud, so it read as lying on top.

## Options

- **Raise the layer only.** Needed where no height is published, but it changes little where the
  volume draws the clouds: the channels kept their crisp look over the anvils.
- **Hide in-cloud channels at a slant.** Physical (a flash seen through hundreds of kilometres of
  cloud is a diffuse glow), but lightning nearly disappears at the steepest tilt.
- **Make every cloud more transparent.** Lightning shows everywhere, but the sea shows through dense
  decks again (ADR 0031 moved from 0.8 to 0.95 for that).
- **Transparent from above, veiled at a slant** (chosen, recommended to the maintainer among four
  captured looks).

## Decision

1. **Layer**: the flat cloud shell at 13 km, over the glows and every channel (styled, bound: at most
   1 km over the 12 km glow).
2. **Glows**: under the drawn top less half a kilometre where heights are known, as the channels.
3. **Veil**: seen from above a flash meets 55 % of the cloud's opacity (`VEIL.through`); over slant
   paths of 1.5 to 4 (1 / cosine of the view to the vertical, at most 5) the cloud crossed toward the
   eye takes over: the opacity thickens as the limb of the layer does and the light spreads up to five
   times farther (`seenThrough`). Channels below the cloud take the same 55 % from above.

## Consequences

- From above, channels read through the clouds; at the steepest tilt they glow inside their cloud
  instead of standing on it.
- Cloud parallax over the ground grows by the 3 km raise in tilted views of the flat layer.
- The methodology names the raised layer and the transparency over lightning as styled.
