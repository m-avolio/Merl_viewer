# MERL Sphere Viewer

A dependency-free WebGL2 viewer for the MERL isotropic BRDF database. The app streams one preprocessed material at a time, uploads it as a 180 x 90 x 90 3D texture, and evaluates the BRDF on the GPU for a live sphere preview.

## Render Strategy

- MERL `.binary` files are 90 x 90 x 180 samples with three double-precision color planes, about 33 MB per material.
- `npm run preprocess` converts each material into an interleaved RGB16F log-encoded 3D texture chunk, about 8.3 MB per material.
- If `envmap.exr` is in the project root, preprocessing also writes a tone-mapped half-float `public/env/envmap.env16` that the viewer loads by default.
- The browser fetches only `public/merl/manifest.json` and the selected material chunk.
- The shader reconstructs MERL half/difference coordinates per fragment and samples the BRDF texture directly on the GPU.
- Point light mode costs one BRDF lookup per fragment. Environment mode is currently isolated in `src/shaders/sphere.frag.glsl` so it can be replaced cleanly as we settle on a better strategy.

## File Layout

- `src/main.js` starts the app and handles startup failures.
- `src/viewer.js` owns the viewer state, UI wiring, render loop, and texture lifecycle.
- `src/shaders/` contains the WebGL shader source.
- `src/materials.js` streams and uploads preprocessed MERL BRDF chunks.
- `src/environment.js` loads the default preprocessed env map or a user replacement.
- `src/gl-utils.js`, `src/mesh.js`, `src/math.js`, and `src/default-env.js` hold reusable support code.

## Run

```bash
npm run preprocess
npm run serve
```

Open `http://localhost:5173`.

No package install is required.
