/* Copy for the first two sections of the landing (Intro and Instrument), the depth gauge and
 * the hero loop's toggle, in the three locales.
 *
 * Terminology follows the lock in vendor/landing-ui/src/i18n.ts. The verdict words are NOT
 * written here: the components read them from the shared strings, so the chip under the loop
 * and the live readout below it can never disagree. The caption names the canal the way the
 * EN line does, by its short form ("canal" / "conducto"); the readout carries the full term.
 * Spanish is usted, like every shared string. `{name}` slots are filled by the components and
 * every number that fills them comes from a file, never from this one (LOOP_CANAL_MM is the
 * one exception, and says why it has to live here).
 *
 * Lengths matter on a phone: Intro.astro's --intro-chrome and the pin fit in Instrument.astro
 * were measured against these exact strings. A longer heading, caption or note needs a
 * re-measure (the method is in the builder report that came with these files).
 */
import type { Locale } from '@dicomsegvr/landing-ui/types';

/** The clearance the app printed on the canal in the hero loop's own footage.
 *
 * It is read off the picture, not computed: raw3, zoom-read at 212.5 s as
 * "7.77 mm canal CLEAR off-plane" (rawlog.json, state timeline). That state holds unchanged
 * from 124.93 s to the end of the take, so it covers the whole loop window (214.0-217.6 s),
 * and it is the label legible in the film at 2:15. "off-plane" means the nearest canal point
 * is off the cut plane; the caption drops it because the page has no cut plane.
 * The media manifest records sizes and codecs, not what the footage shows, so this one
 * figure is declared here with its provenance instead of being typed into markup.
 */
export const LOOP_CANAL_MM = 7.77;

const en = {
  title: {
    /** EN mirrors the post's line break ("Plan a dental implant / with your hands."), so the
     *  two halves are blocks; ES and PT are longer and wrap with text-wrap: balance instead. */
    lines: ['Plan a dental implant', 'with your'] as [string, string],
    accent: 'hands.',
    split: true,
  },
  loop: {
    alt: 'Two hands in ImplantPlan VR hold a translucent jaw with an implant placed in it and the inferior alveolar canal in red; floating labels grade each clearance.',
    recorded: 'Recorded in ImplantPlan VR on a Meta Quest.',
    clearance: 'Canal clearance: {mm} mm,',
    pause: 'Pause the clip',
    play: 'Play the clip',
  },
  film: 'Watch the film',
  /** Phones show only `name`: at 360 px "Watch the film 2:27" plus the full label is 342 px
   *  for a 320 px column, and a wrapped CTA row costs the loop 52 px of height. */
  vr: { verb: 'Get', verbSoon: 'See', name: 'ImplantPlan VR' },
  /** At most 20 words: the hero gets four text elements and this is the only paragraph. */
  sub: 'Real CBCT scans on the web and on Meta Quest. Place, tilt and resize the implant; the server grades each change.',
  disclaimer: 'Research and education only · Not a medical device · Not for diagnostic use',
  instrument: {
    title: 'Now seat one yourself.',
    sub: 'A {d} × {l} mm implant at FDI {fdi}, in a real segmented mandible. Scroll to seat it and watch the grade change.',
    note: 'Measured off a display mesh to illustrate the method. The app measures on the voxel grid.',
    posterAlt: 'Rendered illustration of a titanium implant and crown in a translucent mandible, above the inferior alveolar canal.',
  },
  gauge: {
    label: 'Platform depth below the crest',
    aria: 'Platform depth below the crest, from 0 to {max} mm. {tight} from {tightMm} mm, {breach} from {breachMm} mm.',
  },
};

export type IntroStrings = typeof en;

const es = {
  title: {
    lines: ['Planifique un implante dental', 'con sus'],
    accent: 'manos.',
    split: false,
  },
  loop: {
    alt: 'Dos manos en ImplantPlan VR sostienen una mandíbula translúcida con un implante colocado y el conducto dentario inferior en rojo; etiquetas flotantes clasifican cada distancia de seguridad.',
    recorded: 'Grabado en ImplantPlan VR en un visor Meta Quest.',
    clearance: 'Distancia al conducto: {mm} mm,',
    pause: 'Pausar el clip',
    play: 'Reproducir el clip',
  },
  film: 'Ver el vídeo',
  vr: { verb: 'Instalar', verbSoon: 'Ver', name: 'ImplantPlan VR' },
  sub: 'Estudios CBCT reales en la web y en Meta Quest. Coloque, incline y ajuste el implante; el servidor clasifica cada cambio.',
  disclaimer: 'Solo para investigación y docencia · No es un producto sanitario · No apto para uso diagnóstico',
  instrument: {
    title: 'Ahora colóquelo usted.',
    sub: 'Un implante de {d} × {l} mm en el FDI {fdi}, en una mandíbula real segmentada. Desplácese para asentarlo y vea cómo cambia la clasificación.',
    note: 'Medido sobre una malla de visualización, para ilustrar el método. La aplicación mide en la rejilla de vóxeles.',
    posterAlt: 'Ilustración renderizada de un implante de titanio con su corona en una mandíbula translúcida, por encima del conducto dentario inferior.',
  },
  gauge: {
    label: 'Profundidad de la plataforma bajo la cresta',
    aria: 'Profundidad de la plataforma bajo la cresta, de 0 a {max} mm. {tight} desde {tightMm} mm, {breach} desde {breachMm} mm.',
  },
} satisfies IntroStrings;

const ptBR = {
  title: {
    lines: ['Planeje um implante dentário', 'com as próprias'],
    accent: 'mãos.',
    split: false,
  },
  loop: {
    alt: 'Duas mãos no ImplantPlan VR seguram uma mandíbula translúcida com um implante posicionado e o canal mandibular em vermelho; rótulos flutuantes classificam cada distância de segurança.',
    recorded: 'Gravado no ImplantPlan VR em um Meta Quest.',
    clearance: 'Distância ao canal: {mm} mm,',
    pause: 'Pausar o clipe',
    play: 'Reproduzir o clipe',
  },
  film: 'Ver o vídeo',
  vr: { verb: 'Instalar o', verbSoon: 'Conhecer o', name: 'ImplantPlan VR' },
  sub: 'Exames CBCT reais, na web e no Meta Quest. Posicione, incline e ajuste o implante; o servidor classifica cada mudança.',
  disclaimer: 'Somente pesquisa e ensino · Não é um dispositivo médico · Não destinado a uso diagnóstico',
  instrument: {
    title: 'Agora é a sua vez.',
    sub: 'Um implante de {d} × {l} mm no FDI {fdi}, em uma mandíbula real segmentada. Role a página para instalá-lo e veja a classificação mudar.',
    note: 'Medido em uma malha de exibição para ilustrar o método. O aplicativo mede na grade de voxels.',
    posterAlt: 'Ilustração renderizada de um implante de titânio com coroa em uma mandíbula translúcida, acima do canal mandibular.',
  },
  gauge: {
    label: 'Profundidade da plataforma abaixo da crista',
    aria: 'Profundidade da plataforma abaixo da crista, de 0 a {max} mm. {tight} a partir de {tightMm} mm, {breach} a partir de {breachMm} mm.',
  },
} satisfies IntroStrings;

export const intro: Record<Locale, IntroStrings> = { en, es, 'pt-br': ptBR };

/** `{mm}` -> value. Unknown slots render empty rather than as a literal brace. */
export const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
