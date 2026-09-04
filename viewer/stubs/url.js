/* A browser stand-in for node's `url`.
 *
 * RECOVERED, not written: transcribed from `web/viewer.js` on 2026-09-02. The error
 * message below is the string that identified this file's original path after the
 * 2026-09-01 tree deletion -- it names `viewer/stubs/url.js`, which is how the lost
 * layout was reconstructed rather than guessed.
 *
 * `@kitware/vtk.js` reaches `url` through `xmlbuilder2`. `URL` and `URLSearchParams`
 * exist in every browser, so those are real; the legacy node functions are not
 * shimmable in a browser and would be wrong if faked, so they THROW with a message
 * naming themselves. A stub that returns a plausible value for `url.parse()` would turn
 * a missing dependency into a silently wrong result, which is the failure mode this
 * whole codebase is organised against.
 *
 * Note the asymmetry, and keep it: the NAMED exports include `domainToASCII`,
 * `domainToUnicode`, `fileURLToPath` and `pathToFileURL`, and the DEFAULT object does
 * not. That is what the shipped bundle has, and the export table is one of the
 * fingerprints `check-bundle.mjs` compares.
 */
const notInBrowser = (name) => () => {
  throw new Error(
    `node url.${name}() is not available in the browser bundle (viewer/stubs/url.js)`);
};

export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

export const parse = notInBrowser('parse');
export const format = notInBrowser('format');
export const resolve = notInBrowser('resolve');
export const domainToASCII = notInBrowser('domainToASCII');
export const domainToUnicode = notInBrowser('domainToUnicode');
export const fileURLToPath = notInBrowser('fileURLToPath');
export const pathToFileURL = notInBrowser('pathToFileURL');

export default { URL, URLSearchParams, parse, format, resolve };
