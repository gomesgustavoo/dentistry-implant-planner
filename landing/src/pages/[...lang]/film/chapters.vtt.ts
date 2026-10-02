/* WebVTT chapter track for the film player, one per locale: /film/chapters.vtt,
 * /es/film/chapters.vtt, /pt-br/film/chapters.vtt.
 *
 * Cue starts are media.json film.chapters (the same times the encoder forced keyframes at),
 * each cue ends where the next starts, and the last ends at the film's measured duration, so
 * the track always agrees with the file it describes. Titles come from content/film.ts.
 * The URL is not content-hashed: nginx serves .vtt in the no-cache HTML tier.
 */
import type { APIRoute } from 'astro';
import { localeStaticPaths } from '@dicomsegvr/landing-ui/i18n';
import type { Locale } from '@dicomsegvr/landing-ui/types';
import { media } from '../../../lib/media';
import { film } from '../../../content/film';

export const getStaticPaths = localeStaticPaths;

/** 45.5 -> "00:00:45.500" (WebVTT requires hours when they are written, and ms always). */
function stamp(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

/** Cue payloads are text; "<", "&" and the "-->" arrow must never reach the parser raw. */
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const GET: APIRoute = ({ props }) => {
  const { locale } = props as { locale: Locale };
  const { chapters: starts, duration } = media.film;
  const titles = film[locale].chapters;
  if (starts.length !== titles.length) {
    throw new Error(`media.json has ${starts.length} chapter starts but content/film.ts names ${titles.length}`);
  }
  const cues = starts.map((start, i) => {
    const end = starts[i + 1] ?? duration;
    if (!(end > start)) throw new Error(`chapter ${i + 1} ends (${end}) before it starts (${start})`);
    return `${i + 1}\n${stamp(start)} --> ${stamp(end)}\n${escape(titles[i])}`;
  });
  return new Response(`WEBVTT\n\n${cues.join('\n\n')}\n`, {
    headers: { 'Content-Type': 'text/vtt; charset=utf-8' },
  });
};
