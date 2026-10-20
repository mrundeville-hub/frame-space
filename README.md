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
| Rotation | Y angle in degrees; drag it to take over |
| Frame opacity | Opacity of the active frame card, 100% opaque down to 0% invisible |
| Volume opacity | Extinction per unit depth — low reads as glass, high as a solid slab |
| Player (▶ / scrubber / Space) | The active frame: an opaque card showing the video frame at the playhead, moving through the faint volume from the first frame to the last. ▶ plays it at the clip's own speed and loops; drag the scrubber to jump to any frame |
| Tilt | Pitch of the cube; with Rotation and drag you can turn it any way. The default is a true isometric view |
| Roll time | Bends the time axis into an arc, 0° flat to 360° a closed ring |
| View | **Volume** is the glass block; **Solid** draws only the surface, so the side faces show the motion as streaks |
| Layers | Keeps density only in thin plates, one per few frames, so the clip reads as separate stacked frames |
| Shape | **Box**, **Lens** (the picture shrinks toward the first and last frame) or **Circle** (a cylinder along time) |
| Plane / Cut | **Plane** keeps the whole volume and draws the active frame inside it; **Cut** also removes everything after the playhead so the block grows as the clip plays |
| Iso / Persp | Parallel (isometric) or perspective camera |
| Blur | Averages each sample with neighbours across the picture and time, so frames smear into one soft volume |
| Split view | Top: the volume, orbit it. Bottom: the same volume seen straight down its time axis (the "through the volume" view). Single view gives one large stage |
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
