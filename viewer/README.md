# `viewer/` — the DentistryViewer bundle

`web/viewer.js` is a committed build artifact, because the web image has no build step.
This directory is its source.

```bash
npm --prefix viewer install --ignore-scripts   # 88 packages, 94 MB, ~6 s
npm --prefix viewer run build:candidate        # -> viewer/dist/viewer.js
node viewer/check-bundle.mjs                   # artifact differential (no browser)
node viewer/check-equivalence.mjs              # runtime differential (real GPU, real case)
npm --prefix viewer run build                  # copies the candidate over web/viewer.js
```

## This is a reconstruction, and here is exactly how faithful it is

The `viewer/` tree was destroyed on 2026-09-01 (see `../RECOVERY-2026-09-01.md`). The
built bundle was the only surviving copy. `src/index.js` was **transcribed** from it on
2026-09-02, function for function: identifiers there are mangled, but every function,
constant, transfer function, tool binding and error string survived, so this was a
transcription against a known dependency set rather than a reinvention.

The app-authored region of the old artifact is bytes **3,981,451–3,997,975** (16,524
bytes), immediately after the last `@cornerstonejs/tools` statement
(`OX.toolName="VideoRedaction";`). It contained exactly 22 top-level functions, 18
module bindings, 62 distinct string literals and 14 multi-digit numeric constants. All of
them are accounted for in `src/index.js`, and `check-bundle.mjs` asserts the literal and
constant sets mechanically rather than taking anyone's word for it.

The v5 artifact is preserved at `reference/viewer-v5-shipped.js` and is the **oracle**
both differential tests compare against. It has to be preserved: once the rebuild ships,
`web/viewer.js` *is* the candidate, and comparing it with itself would pass vacuously.
There is no git history in this tree to recover it from.

### What was measured, not assumed

| | |
|---|---|
| size drift | 6,650 bytes, **0.17%** (the candidate adds the implant module) |
| app-region literals | **62 of 62** present in the candidate |
| app-region constants | **14 of 14** present |
| bundled module export tables | all but one identical; the exception is `HistoryMemo`, which the app region never references and which IS in the candidate, reachable by a different path |
| public API | 17 shipped names, **none lost**; 7 added, all of them the implant API |
| runtime `debugState()` | **identical**, on a real case, on the real GPU, once the mount counter and Cornerstone's random actor UUIDs are normalised |
| surfaces | 42 added, **1,949,576 triangles**, colour LUT read back 42/42 correct, 43 actors |
| 3D camera | identical to 0.1 mm |
| implant geometry vs Python | **4.06e-6 mm** worst vertex error over 320 sampled vertices, 8 poses, both jaws, tilts −35° to +20° |
| implant frame orthonormality | worst `|dot|` **1.7e-16** |

**Byte identity was not achieved and was not chased.** Adding the implant module changes
the output by construction, and `--minify-identifiers` renames by whole-bundle frequency
so a single new app identifier reshuffles short names across all 3.8 MB. `web-auth`
accepted 70,962 versus 70,972 bytes for `auth.js` on the same reasoning; the evidence
here is considerably stronger than that.

### Dependency versions are determined, not chosen

`@cornerstonejs/tools@5.8.2` declares its peers as exact pins:

```
@cornerstonejs/core 5.8.2 · @kitware/vtk.js 36.4.1 · gl-matrix 3.4.3
d3-array 3.2.4 · d3-interpolate 3.0.1
```

and every one of those has a literal fingerprint in the preserved artifact
(`var WY="5.8.2"`, the pako 2.1.0 licence line, and so on). `package-lock.json` is the
reproducibility record; commit it with any change.

`dicom-parser` is deliberately **absent**: nothing here loads DICOM in the browser, and
`check-bundle.mjs` asserts `parseDicom` never appears in the output.

## The two node stubs are recovered, not written

`stubs/events.js` and `stubs/url.js` are transcriptions from the same artifact.
`@kitware/vtk.js` pulls `xmlbuilder2`, which wants node's `events` and `url`. The url
stub's own error message is what identified the lost layout — it names
`viewer/stubs/url.js`, which is how the directory structure was reconstructed rather than
guessed.

Keep their export surfaces exactly as they are. The `url` stub's named exports include
four functions the default object does not, and that asymmetry is in the shipped
artifact; the export table is one of the fingerprints the differential test compares.

## Things that look wrong and are not

1. **`polySeg` is stubbed to no-ops.** Cornerstone 5.8.2's Surface representation does
   not render supplied geometry, and its `getUpdateFunction` closes over `polySeg` with
   no null check, so registration *throws* before `render()`. Surfaces are plain vtk.js
   actors instead. The stub is also what keeps `@cornerstonejs/polymorphic-segmentation`
   and `@icr/polyseg-wasm` out of the bundle — two reasons, one object. **Do not retry
   the Surface representation on 5.8.2.**
2. **`renderViewports(mprIds)` fires inside the `if` test**, as a comma expression,
   before the `SEGMENTATION_RENDERED` await. Written the obvious way, nothing triggers
   the event, the 4 s timeout always expires, and the 3D pane starves the segmentation
   render loop again. It still *works* via the timeout, just slowly and in the wrong
   order, so no test catches it. A mount that takes the full 4 s is the tell.
3. **No Crosshairs, Length, Angle or Probe tool.** The MPR volume is an 8-bit copy
   downsampled to ~0.66 mm; a ruler on it would disagree with the server about the same
   gap. All measurement lives in the plan tab against server-published `pixel_mm`.
4. **The colour LUT is written and then read back.** `colorLUTOrIndex` must be nested
   inside `config`; at the top level it type-checks, does nothing, and reports no error.
5. **The unused `GeometryType` destructure is transcribed on purpose.** It occurs exactly
   once in the whole artifact, so it is provably dead code the minifier still emitted.
6. **`registerUnknownImageLoader` is process-wide.** It makes the dentistry loader the
   fallback for every unrecognised scheme, forever. Fine here — nothing else on the page
   uses Cornerstone — and hostile to any second consumer that ever does.

## Headless Chrome DOES reach the GPU on this box

The standing note that "headless Chrome measurements of Cornerstone on this box are
worthless" was formed with `--disable-gpu`, which **guarantees** SwiftShader and fully
explains the 11 s mount that is really 173 ms. Measured 2026-09-02 with
`--use-angle=gl-egl --ozone-platform=headless` and no `--disable-gpu`:

```
ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3080/PCIe/SSE2, OpenGL ES 3.2)
```

so `check-equivalence.mjs` runs the real thing unattended. It asserts the renderer
string and refuses to compare anything if it reads SwiftShader — a comparison on a
software rasteriser would be two wrong answers agreeing.

**Timing is still never asserted.** A headless GPU context is not the user's browser,
and a frame budget measured here would be a number about the harness.

## Traps paid for while building this

- **`check-equivalence.mjs`'s page probes are template-literal bodies. No backticks in
  their comments** — a backtick closes the literal and the file becomes a syntax error.
  This has now cost two debugging rounds in this repo (`web-auth/check-rail.mjs` has the
  same hazard and the same warning).
- **The literal-comparison oracle must skip regex literals.** A regex like ``/[ "<>`]/``
  contains a double quote and a backtick, so a naive string scanner starts a "string"
  inside it and consumes arbitrary code. That produced 140 phantom missing literals on
  the first run, all of them `xmlbuilder2` fragments that were present in both bundles.
- **Template literals are not rename-invariant.** Their `${...}` interpolations carry
  minified identifiers, so the same template differs between builds by construction.
  Asserting on whole-bundle literals produced 243 more phantom differences. Only the
  app region's literals are compared exactly; the rest is reported, not asserted.
- **The JS implant mesh is INDEXED and the Python one is per-triangle.** Comparing raw
  vertex arrays by offset compares ~380 unique vertices against 2,160 duplicated ones
  and reports an 8 mm error on geometry that matches to 1e-10. The index buffer is
  expanded and diffed triangle-for-triangle instead.
