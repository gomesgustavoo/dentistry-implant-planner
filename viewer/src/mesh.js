/* The `DSVM` browser mesh format, parsed in ONE place.
 *
 * Written by `worker/meshes.py` and read by two callers now -- the case viewer's anatomy
 * surfaces (`index.js`) and the model picker's baked dentition (`preview.js`). It lived
 * inside `index.js` while there was one caller; a second copy of a binary parser is a
 * second place for an off-by-sixteen to hide, and this repo's stated discipline is one
 * map with one place to be wrong.
 */

/** Parse the custom `DSVM` browser mesh format written by `worker/meshes.py`.
 *
 *  Not STL: STL is 50 bytes per triangle with the normal repeated and no shared
 *  vertices. This is `'DSVM'` + uint32 version + uint32 nPoints + uint32 nTris, then
 *  the points as float32 LPS millimetres and the triangles as uint32 indices. The
 *  exact byte-length assertion is what catches a truncated fetch, which otherwise
 *  renders as a partial mesh that looks like a segmentation error.
 *
 *  vtk.js wants its cell array with an explicit vertex count per cell, so the three
 *  indices per triangle are expanded to `[3, a, b, c]` here.
 */
export function parseWebMesh(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'DSVM') {
    throw new Error(`not a dentistry mesh (magic ${JSON.stringify(magic)})`);
  }
  const version = view.getUint32(4, true);
  if (version !== 1) {
    throw new Error(`mesh format version ${version} is newer than this viewer`);
  }
  const nPoints = view.getUint32(8, true);
  const nTris = view.getUint32(12, true);
  const expected = 16 + nPoints * 12 + nTris * 12;
  if (buffer.byteLength !== expected) {
    throw new Error(`mesh is ${buffer.byteLength} bytes, header says ${expected}`);
  }
  const points = new Float32Array(buffer.slice(16, 16 + nPoints * 12));
  const tris = new Uint32Array(buffer.slice(16 + nPoints * 12));
  const cells = new Uint32Array(nTris * 4);
  for (let t = 0, c = 0, s = 0; t < nTris; t++) {
    cells[c++] = 3;
    cells[c++] = tris[s++];
    cells[c++] = tris[s++];
    cells[c++] = tris[s++];
  }
  return { points, cells, nPoints, nTris };
}
