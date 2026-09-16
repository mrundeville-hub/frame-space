# FRAME/SPACE

A local browser prototype that turns a video into a transparent 3D temporal frame stack.

## Run locally

```bash
npm run dev
```

Open http://localhost:4173.

Drop any MP4, MOV, or WebM file. Frames are extracted in the browser and placed sequentially in one depth stack. Playback controls the active frame; drag rotates the volume independently.

## Notes

- No backend or upload is required.
- Export creates a WebM recording of the current WebGL view.
- `public/reference.mp4` is only the included visual reference sample.
