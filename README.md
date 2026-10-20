# FRAME / SPACE

Turn a video clip into a volume. Every sampled frame becomes one layer of a 3D
texture, so the clip's time axis becomes the block's depth axis — the shape you
see is the motion.

## Run

```bash
npm run dev          # python3 -m http.server 4173
```

Open <http://localhost:4173>. Drop any MP4, MOV or WebM anywhere on the page, or
use **Open video**. Nothing is uploaded; decoding, sampling and rendering all
happen in the browser.

## Controls

| Control | What it does |
| --- | --- |
| Frame spacing | Depth of the block divided by the frame count |
| Rotation | Y angle in degrees; tracks the slow auto-turn, drag it to take over |
| Opacity | Extinction per unit depth — low reads as glass, high as a solid slab |
| Cut through | Slices the volume away along the cut axis and draws the cut face solid — drag it to look inside, or scrub through time |
| Roll time | Bends the time axis into an arc, 0° flat to 360° a closed ring |
| View | **Volume** is the glass block; **Solid** draws only the surface, so the side faces show the motion as streaks |
| Cut axis | **X** / **Y** slice the picture plane, **T** slices through time (one frame at the cut) |
| Play cut | Sweeps the cut through the clip on a loop |
| Drag the stage | Orbit |
| Scroll | Zoom |
| Still / Record turn | PNG of the current view / WebM of one full revolution |

## How it renders

`app.js` seeks the clip at 192 evenly spaced times and packs each frame into a
`THREE.Data3DTexture` (192 layers, longest spatial side 192px). One box mesh is
drawn with back faces; the fragment shader intersects the view ray with the
box in object space and raymarches 160 steps front to back, compositing with
`1 - exp(-sigma * dt)`. A rounded-box SDF, evaluated in world units so the
rounding stays even on a non-cubic block, fades density near the shell — that's
where the soft rounded silhouette comes from. The entry point is jittered per
pixel so the fixed step count does not band.

Rolling inverts a bend in the shader: each sample's world position is mapped back
to slab coordinates (radius → x, arc length → time) before the volume is read, so
the same raymarch draws a flat block, an arc or a ring. The cut works in volume
coordinates, and the first kept sample after sliced-away ones is the cut face.

Requires WebGL2 (`sampler3D`).

## Files

- `public/sample.mp4` — generated default clip, loaded on start.
