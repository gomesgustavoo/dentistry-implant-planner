/** The ImplantPlan VR APK, as found by scripts/apk-manifest.mjs at build time.
 *
 * `available: false` is a real, shippable state (the download page says the build is
 * coming); every figure shown when it is true comes from the file itself.
 */
import manifest from '../generated/apk.json';

export type ApkManifest =
  | { available: false }
  | {
      available: true;
      /** Semver from the dropped file's name, ImplantPlanVR-<version>.apk. */
      version: string;
      /** Name the browser saves it as (the `download` attribute). */
      file: string;
      /** Content-hashed URL, /download/ImplantPlanVR-<version>-<sha8>.apk. */
      href: string;
      bytes: number;
      sha256: string;
    };
export const apk = manifest as ApkManifest;
