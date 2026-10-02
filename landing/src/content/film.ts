/* The ImplantPlan VR film: chapter titles, player strings and the on-screen-text transcript.
 *
 * Times are NOT typed here for the chapters: their starts live in media.json (film.chapters),
 * because scripts/make_vr_media.mjs forces a keyframe at each of them and the player seeks to
 * them. This file only names them, in film order.
 *
 * Every line of the transcript was read off implantplan-vr-film-web.mp4 itself (the file the
 * player streams, 1920x1080 CFR 30): 1 s contact sheets with the true pts burned in, then
 * 0.1-0.25 s sheets around each chapter card and the opening montage. Each `t` is the second a
 * caption card first shows (floored), so a seek to it lands on the card, not before it.
 * Two things the older 3 s sheet (film_sheet_01) missed and the beat sheet lists as "none":
 * the montage words Grade. (0:08) and Save. (0:13), between Place. Inspect. Cut.
 * The small kicker labels above each card (SIGN IN, RESIZE...) and the mono read-outs under
 * two of them (3.54 mm at 1:11, the voxel grid at 1:52) are left out: they are UI labels, and
 * this page only prints figures it can source.
 */
import type { Locale } from '@dicomsegvr/landing-ui/types';

type Seven = readonly [string, string, string, string, string, string, string];

const en = {
  /** Chapter 1 is the title card's own line; 2-7 are the film's numbered chapter chips. */
  chapters: [
    'Implant planning on real CBCT scans',
    'Segment the scan',
    'Plan in the browser',
    'Step into the headset',
    'Place and grade',
    'Cut through the scan',
    'Back to the web app',
  ] as Seven,
  /** h2 of the dialog; `length` is clock(media.film.duration), "2:27". */
  title: (length: string) => `ImplantPlan VR: the film (${length})`,
  close: 'Close the film',
  fullscreen: 'Full screen',
  chaptersLabel: 'Chapters',
  /** Accessible name of a transcript time button in the player. */
  seekFrom: (time: string) => `Play from ${time}`,
  transcriptSummary: "Read the film's on-screen text",
  transcriptNote: 'The film is silent: everything it says is on screen, written out here.',
  endCardLabel: 'End card, as shown in the film:',
  error: 'This browser could not play the film here.',
  errorLink: 'Open the video file',
};
export type FilmStrings = typeof en;

const es = {
  chapters: [
    'Planificación de implantes en estudios CBCT reales',
    'Segmente el estudio',
    'Planifique en el navegador',
    'Entre en el visor',
    'Coloque y clasifique',
    'Corte a través del estudio',
    'De vuelta a la aplicación web',
  ] as Seven,
  title: (length: string) => `ImplantPlan VR: el vídeo (${length})`,
  close: 'Cerrar el vídeo',
  fullscreen: 'Pantalla completa',
  chaptersLabel: 'Capítulos',
  seekFrom: (time: string) => `Reproducir desde ${time}`,
  transcriptSummary: 'Leer el texto que aparece en el vídeo',
  transcriptNote: 'El vídeo no tiene sonido. Su texto en pantalla está en inglés y se reproduce aquí tal cual.',
  endCardLabel: 'Cartela final, tal como aparece en el vídeo:',
  error: 'Este navegador no pudo reproducir el vídeo aquí.',
  errorLink: 'Abrir el archivo de vídeo',
} satisfies FilmStrings;

const ptBR = {
  chapters: [
    'Planejamento de implantes em exames de CBCT reais',
    'Segmente o exame',
    'Planeje no navegador',
    'Entre no headset',
    'Posicione e classifique',
    'Corte através do exame',
    'De volta ao aplicativo web',
  ] as Seven,
  title: (length: string) => `ImplantPlan VR: o vídeo (${length})`,
  close: 'Fechar o vídeo',
  fullscreen: 'Tela cheia',
  chaptersLabel: 'Capítulos',
  seekFrom: (time: string) => `Reproduzir a partir de ${time}`,
  transcriptSummary: 'Ler o texto que aparece no vídeo',
  transcriptNote: 'O vídeo não tem som. O texto na tela está em inglês e aparece aqui exatamente como no vídeo.',
  endCardLabel: 'Cartela final, como aparece no vídeo:',
  error: 'Este navegador não conseguiu reproduzir o vídeo aqui.',
  errorLink: 'Abrir o arquivo de vídeo',
} satisfies FilmStrings;

export const film: Record<Locale, FilmStrings> = { en, es, 'pt-br': ptBR };

/** Figures the page quotes from the film's own captions (the resize card, 1:35; read on the
 *  frame, not from the app). The chapter rows format them with decimal() per locale. */
export const filmFigures = { widenFrom: 4.3, widenTo: 6.0 } as const;

/**
 * The film's burned-in English text, in order. `chapter` rows are the numbered chips
 * (index into `chapters` and media.json film.chapters, which supplies their time).
 * The end card is labelled as film text on the page: it is what the film says, never a
 * claim the page makes in its own voice.
 */
export type TranscriptEntry =
  | { kind: 'line'; t: number; text: string }
  | { kind: 'chapter'; chapter: number }
  | { kind: 'card'; t: number; lines: readonly string[] };

export const transcript: readonly TranscriptEntry[] = [
  { kind: 'line', t: 2, text: 'Dental CBCT · Web app + Meta Quest. ImplantPlan. Implant planning on real CBCT scans. In the browser and in the headset.' },
  { kind: 'line', t: 6, text: 'Place.' },
  { kind: 'line', t: 8, text: 'Grade.' },
  { kind: 'line', t: 10, text: 'Inspect.' },
  { kind: 'line', t: 12, text: 'Cut.' },
  { kind: 'line', t: 13, text: 'Save.' },
  { kind: 'line', t: 15, text: "Every planner draws the nerve. None of them tells you how wrong it is. ImplantPlan grades every clearance with the model's own measured error subtracted." },
  { kind: 'chapter', chapter: 1 },
  { kind: 'line', t: 24, text: 'Model A and Model B were trained here, on our own GPUs.' },
  { kind: 'line', t: 27, text: 'Both jaws, every tooth in FDI, the nerve canals, the sinuses.' },
  { kind: 'line', t: 30, text: "The model's own error, per structure, beside what it drew." },
  { kind: 'chapter', chapter: 2 },
  { kind: 'line', t: 36, text: "Clearance to the canal as a number, with the model's error deducted." },
  { kind: 'line', t: 38, text: 'Seat it deeper and the verdict moves. Refused, not softened.' },
  { kind: 'line', t: 43, text: 'Angle it in three axes.' },
  { kind: 'chapter', chapter: 3 },
  { kind: 'line', t: 48, text: "Sign in on the headset. The web app's cases and grading come with you." },
  { kind: 'line', t: 51, text: 'A dental clinic, the mountains or a lake. Switch any time.' },
  { kind: 'line', t: 57, text: 'Every structure the models drew, in 3D, at true scale.' },
  { kind: 'line', t: 62, text: 'Show or hide any of the 41 structures.' },
  { kind: 'chapter', chapter: 4 },
  { kind: 'line', t: 68, text: 'Point at a gap. The server measures, then grades.' },
  { kind: 'line', t: 71, text: 'Canal, incisive canal, adjacent tooth. Each clearance comes back graded.' },
  { kind: 'line', t: 75, text: 'The same checks in the browser and in the headset.' },
  { kind: 'line', t: 80, text: 'Scale the case up to see the canal around the implant.' },
  { kind: 'line', t: 85, text: 'Tilt it by hand. B-L and M-D angles update live.' },
  { kind: 'line', t: 92, text: 'Lengthen it to 14 mm: too close to the canal.' },
  { kind: 'line', t: 95, text: 'Widen it from 4.3 to 6.0 mm: CLEAR, then TIGHT, then BREACH.' },
  { kind: 'line', t: 100, text: 'Move it off the canal. Until the server answers: NOT GRADED.' },
  { kind: 'chapter', chapter: 5 },
  { kind: 'line', t: 106, text: 'Slice the solid anatomy open on any plane.' },
  { kind: 'line', t: 109, text: 'Grab the plane and sweep it through the jaw.' },
  { kind: 'line', t: 112, text: 'The full-resolution scan on the cut, segmentation outlines on top.' },
  { kind: 'line', t: 118, text: "The browser's cross-section, as a plane you hold." },
  { kind: 'line', t: 123, text: 'Axial, sagittal or free. The scan follows the cut.' },
  { kind: 'chapter', chapter: 6 },
  { kind: 'line', t: 128, text: 'Save in the headset. The plan lands in the web app.' },
  { kind: 'line', t: 132, text: 'Hide the panels. The implant view keeps every clearance on the implant itself.' },
  // 2:19 to the end. The card's own "30 SEGMENTATIONS · 14 DAYS · NO CARD" is written with
  // commas so no line carries more than one middle dot.
  {
    kind: 'card', t: 139, lines: [
      'ImplantPlan',
      "Open source: MIT license. The planner's code, free to use and build on.",
      'Free trial: cloud inference. 30 segmentations, 14 days, no card.',
      'dentistry.dicomsegvr.com',
      'Research preview. Not a medical device.',
    ],
  },
];
