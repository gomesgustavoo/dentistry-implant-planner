/* Assemble CDP screencast frames into a constant-rate MP4.
 *
 * The compositor emits a frame when the page CHANGES, so the stream is dense while the
 * 3-D pane turns and sparse while a caption sits still. Feeding that to ffmpeg at a fixed
 * `-framerate` would play the whole tour at whatever average happened to occur -- the
 * still parts would flash past and the animated parts would crawl.
 *
 * So each frame carries the wall-clock it was composited at, and this writes a concat
 * demuxer script with an explicit `duration` per frame. ffmpeg then resamples to a
 * constant 30 fps, holding a still frame for as long as it was actually still.
 *
 * The last entry is repeated without a duration: the concat demuxer ignores the final
 * `duration` line, and without the repeat the closing shot is dropped.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const FRAMES = process.argv[2];
const OUT = process.argv[3];
// The OUTPUT rate, which is not the capture rate. Frames arrive at ~10/s from the
// recorder's timed loop; ffmpeg resamples to 30 so the file plays smoothly on anything,
// duplicating rather than inventing. The per-frame `duration` below is what carries the
// real timing, and it is why this is a concat script rather than a fixed -framerate.
const OUT_FPS = Number(process.env.TOUR_OUT_FPS || 30);
// A ceiling on how long one frame may be held. Deliberately LARGE, and that is the whole
// point: the captions are burned in against the recorder's own beat timestamps, so the
// video's clock has to match the wall-clock the tour ran on. Capping holds at a couple of
// seconds would compress every still stretch, shorten the video below the storyboard, and
// slide every caption off the thing it names. This exists only to stop a page that went
// quiet at the very end from holding one frame indefinitely.
const MAX_HOLD = Number(process.env.TOUR_MAX_HOLD || 30.0);

const frames = JSON.parse(readFileSync(path.join(FRAMES, 'frames.json'), 'utf8'));
if (frames.length < 30) throw new Error(`only ${frames.length} frames`);

const lines = [];
for (let i = 0; i < frames.length; i++) {
  const next = i + 1 < frames.length ? frames[i + 1].at : frames[i].at + 1 / OUT_FPS;
  const d = Math.min(MAX_HOLD, Math.max(1 / OUT_FPS, next - frames[i].at));
  lines.push(`file '${frames[i].file}'`);
  lines.push(`duration ${d.toFixed(4)}`);
}
lines.push(`file '${frames[frames.length - 1].file}'`);

const listPath = path.join(FRAMES, 'concat.txt');
writeFileSync(listPath, lines.join('\n') + '\n');

const total = frames[frames.length - 1].at - frames[0].at;
console.log(`${frames.length} frames over ${total.toFixed(1)}s -> ${OUT}`);

execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-f', 'concat', '-safe', '0', '-i', listPath,
  '-vsync', 'cfr', '-r', String(OUT_FPS),
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  OUT,
], { stdio: 'inherit', cwd: FRAMES });
