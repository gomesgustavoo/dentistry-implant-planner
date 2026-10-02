/** The web renditions of the ImplantPlan VR footage, as written by scripts/make_vr_media.mjs.
 *
 * Every byte count, size and codec string here is read off the encoded file by the script.
 * Nothing in this manifest is typed by hand, and components must not hard-code any of it:
 * a re-encode changes the hashes, the sizes and possibly the codec level.
 */
import manifest from '../generated/media.json';

export type Aspect = '16x9' | '4x5';
export interface Asset {
  /** Absolute URL under /assets/media/ (content-hashed, immutable). */
  src: string;
  bytes: number;
  width: number;
  height: number;
  /** MIME type, e.g. video/mp4, image/avif. */
  type: string;
  /** RFC 6381 codec string parsed from the avcC / av1C box, e.g. avc1.64001f, av01.0.05M.08. */
  codecs?: string;
  /** Seconds, for video. */
  duration?: number;
}
export interface PosterPair { avif: Asset; webp: Asset }
export interface LoopEntry {
  id: string;
  /** Source capture and in/out, for provenance. */
  source: string; in: number; out: number;
  duration: number;
  poster: Record<Aspect, PosterPair>;
  video: Record<Aspect, { av1: Asset; h264: Asset }>;
}
export interface StillEntry {
  id: string; source: string; t: number;
  sizes: { '1280': PosterPair; '640': PosterPair };
}
export interface FilmEntry {
  duration: number;
  poster: PosterPair;
  av1: Asset; h264: Asset;
  /** Chapter start times (s), first is 0. */
  chapters: number[];
  /** Deep-link times (s) used by the chapter rows. */
  links: number[];
}
export interface MediaManifest {
  version: 1;
  /** sha256 of landing/media/edl.json that produced this manifest. */
  edlHash: string;
  /** Id of the loop that is the hero. */
  hero: string;
  loops: Record<string, LoopEntry>;
  stills: Record<string, StillEntry>;
  film: FilmEntry;
  og: Asset;
  heroFallback: Asset;
}

export const media = manifest as unknown as MediaManifest;
export const heroLoop = (): LoopEntry => media.loops[media.hero];
export const still = (id: string): StillEntry => {
  const s = media.stills[id];
  if (!s) throw new Error(`media.json has no still "${id}"`);
  return s;
};
/** `type` attribute for a <source>: includes codecs when the manifest has them. */
export const sourceType = (a: Asset) => (a.codecs ? `${a.type}; codecs="${a.codecs}"` : a.type);
/** 147.77 -> "2:27" (floor, so it matches the native controls). */
export const clock = (seconds: number) => {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
