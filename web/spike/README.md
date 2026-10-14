# Lightning GPU comparison

Run from `web/` on a machine where Chromium can access the GPU:

```sh
node spike/build.mjs
node spike/run.mjs shots
node spike/run.mjs measure
```

The flat mode retains the production 2D shader before #232. Ribbon uses the production 3D
shader with only the flickering flashes in its instance buffer. The round afterglow is included
in both. `ribbon232` retains the #232 core shader for the #234 GPU comparison; `halo`
adds only an eight-segment main-channel halo, capped at 512 instances and faded at globe scale. Captures cover nadir, 60° and 80° tilt; measurements include 500 active flashes at
1920 × 1080, plus stress cases. Generated files go in `dist/spike/` and are not committed.

Compare GPU medians, not wall times. The output identifies the GPU and timer availability;
null GPU times or a software renderer cannot satisfy the acceptance criterion. Reduced motion
must also be checked in the fixture site, with the browser motion preference enabled.
