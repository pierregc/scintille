# Quality tiers

`web/src/globe/quality.ts` defines three presets. Every visual feature declares its behaviour per
tier there.

| Setting | `low` | `medium` | `high` |
|---|---|---|---|
| Earth textures | 2k | 4k | 4k |
| Pixel ratio cap | 1 | 1.5 | 2 |
| Flashes on the GPU | 65,536 | whole live window | whole live window |
| Clouds lit by flashes (#64) | off | on | on |
| Bicubic cloud filtering | off | on | on |
| Bloom on flashes (#58) | off | off | on (about 0.5 ms GPU per frame) |

- **Initial tier**: phones (coarse pointer, small screen), weak GPUs (Mali, older Adreno, PowerVR,
  Intel HD/UHD, software renderers) and devices with 2 GB of memory or less start `low`; known strong
  GPUs (Apple M, NVIDIA, Radeon RX/Pro) start `high`; anything else `medium`.
- **Runtime**: if the average frame rate stays under 30 fps for 5 s, the globe drops one tier
  (at most every 10 s, never back up). Pixel ratio, cloud light and post-processing follow at once;
  textures and flash capacity keep what was loaded.
- **Override**: `?quality=low|medium|high`. The current tier is on the canvas as `data-quality`.
