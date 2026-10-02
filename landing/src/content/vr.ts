/* Copy for section#demo (VrSection.astro): the three chapter rows, the film block and the
 * ImplantPlan VR card.
 *
 * Each row's caption is the film's own caption at the deep-link time (1:08, 1:35, 1:52),
 * translated; the body sentence paraphrases the neighbouring cards (1:10, 1:25, 1:45 + 2:02).
 * Verdict words are never written here: rows render them through the shared i18n hero3d
 * strings, which carry the terminology lock (SEGURO / AJUSTADO / INVADE, SEGURO / JUSTO / INVADE).
 * Alt text describes what the still actually shows (frames checked at full resolution:
 * raw2 102.4 s, raw3 97.5 s, raw3 187.5 s, raw2 0.5 s).
 */
import type { Locale } from '@dicomsegvr/landing-ui/types';

const en = {
  title: 'Take the plan into the headset.',
  lead: "Sign in on a Meta Quest and the web app's cases and grading come with you. Every change you make by hand is graded again by the same server.",
  /**
   * Advance width, in em, of this locale's longest chapter word in Archivo Display 700 with
   * the -0.03em tracking the word uses (fontTools on src/assets/archivo-display.woff2:
   * "Inspect." 3.63, "Inspeccione." 5.81, "Inspecione." 5.27). It sizes the word to its
   * column, so the longest word of the three never overflows at any width.
   */
  wordFit: 3.63,
  rows: {
    place: {
      word: 'Place.',
      caption: 'Point at a gap. The server measures, then grades.',
      body: 'Canal, incisive canal and adjacent tooth each come back graded.',
      alt: (clear: string) => `In the headset, an implant seated in the gap of a translucent lower jaw, with the red canal beneath it. A floating label grades the canal ${clear} and the panel lists each clearance.`,
    },
    inspect: {
      word: 'Inspect.',
      /** Followed by the three verdict chips, joined by `then`. */
      caption: (from: string, to: string) => `Widen it from ${from} to ${to} mm:`,
      then: 'then',
      body: 'Tilt it by hand: B-L and M-D angles update live, and every resize is graded again.',
      alt: (to: string, breach: string) => `The panel shows the implant widened to ${to} mm and graded ${breach}: its floating labels put it too close to the adjacent tooth, while the canal stays CLEAR.`,
    },
    cut: {
      word: 'Cut.',
      caption: 'The full-resolution scan on the cut, segmentation outlines on top.',
      body: 'Slice the solid anatomy on any plane, axial, sagittal or free, and the scan follows the cut.',
      alt: 'A sagittal CBCT slice held between the hands: the scan in grey, with coloured segmentation outlines and the red canal drawn on top.',
    },
  },
  watchPart: 'Watch this part',
  film: {
    title: 'The whole film',
    meta: (length: string, chapters: number) => `${length}, ${chapters} chapters, silent`,
    card: (length: string) => `Watch the whole film (${length})`,
    index: 'Chapters of the film',
  },
  card: {
    title: 'ImplantPlan VR',
    text: 'For Meta Quest 3, Quest 3S and Quest Pro. It installs from a computer and pairs with your account by a one-time code.',
    version: (version: string, mb: string) => `Version ${version} · ${mb} MB`,
    button: 'Get ImplantPlan VR',
    buttonSoon: 'See ImplantPlan VR',
    soon: 'The download opens on its page shortly.',
    alt: 'The ImplantPlan VR welcome panel in the headset, signed in, with Continue and a choice of environments.',
  },
};
export type VrStrings = typeof en;

const es = {
  title: 'Lleve el plan al visor.',
  lead: 'Inicie sesión en un Meta Quest y los casos y las clasificaciones de la aplicación web le acompañan. Cada cambio que haga con las manos lo vuelve a clasificar el mismo servidor.',
  wordFit: 5.81,
  rows: {
    place: {
      word: 'Coloque.',
      caption: 'Apunte a una brecha edéntula. El servidor mide y después clasifica.',
      body: 'El conducto dentario inferior, el conducto incisivo y el diente adyacente vuelven cada uno con su clasificación.',
      alt: (clear: string) => `En el visor, un implante asentado en la brecha de una mandíbula translúcida, con el conducto en rojo debajo. Una etiqueta flotante clasifica el conducto como ${clear} y el panel enumera cada distancia.`,
    },
    inspect: {
      word: 'Inspeccione.',
      caption: (from: string, to: string) => `Aumente el diámetro de ${from} a ${to} mm:`,
      then: 'luego',
      body: 'Inclínelo con la mano: los ángulos B-L y M-D se actualizan en directo, y cada cambio de tamaño se vuelve a clasificar.',
      alt: (to: string, breach: string) => `El panel muestra el implante ensanchado a ${to} mm y clasificado como ${breach}: sus etiquetas flotantes lo sitúan demasiado cerca del diente adyacente, mientras el conducto sigue SEGURO.`,
    },
    cut: {
      word: 'Corte.',
      caption: 'El estudio a resolución completa sobre el corte, con los contornos de la segmentación encima.',
      body: 'Corte la anatomía sólida en cualquier plano, axial, sagital o libre, y el estudio sigue al corte.',
      alt: 'Un corte sagital del CBCT sostenido entre las manos: el estudio en gris, con los contornos de colores de la segmentación y el conducto en rojo encima.',
    },
  },
  watchPart: 'Ver esta parte',
  film: {
    title: 'El vídeo completo',
    meta: (length: string, chapters: number) => `${length}, ${chapters} capítulos, sin sonido, texto en inglés`,
    card: (length: string) => `Ver el vídeo completo (${length})`,
    index: 'Capítulos del vídeo',
  },
  card: {
    title: 'ImplantPlan VR',
    text: 'Para Meta Quest 3, Quest 3S y Quest Pro. Se instala desde un ordenador y se vincula a su cuenta con un código de un solo uso.',
    version: (version: string, mb: string) => `Versión ${version} · ${mb} MB`,
    button: 'Instalar ImplantPlan VR',
    buttonSoon: 'Ver ImplantPlan VR',
    soon: 'La descarga se abrirá en breve en su página.',
    alt: 'El panel de bienvenida de ImplantPlan VR en el visor, con la sesión iniciada, el botón para continuar y la elección de entorno.',
  },
} satisfies VrStrings;

const ptBR = {
  title: 'Leve o planejamento para o headset.',
  lead: 'Entre com a sua conta em um Meta Quest e os casos e as classificações do aplicativo web vão junto. Cada mudança que você faz com as mãos é classificada de novo pelo mesmo servidor.',
  wordFit: 5.27,
  rows: {
    place: {
      word: 'Posicione.',
      caption: 'Aponte para uma área edêntula. O servidor mede e depois classifica.',
      body: 'Canal mandibular, canal incisivo e dente adjacente voltam, cada um, com a sua classificação.',
      alt: (clear: string) => `No headset, um implante instalado na área edêntula de uma mandíbula translúcida, com o canal em vermelho logo abaixo. Um rótulo flutuante classifica o canal como ${clear} e o painel lista cada distância.`,
    },
    inspect: {
      word: 'Inspecione.',
      caption: (from: string, to: string) => `Aumente o diâmetro de ${from} para ${to} mm:`,
      then: 'depois',
      body: 'Incline com a mão: os ângulos B-L e M-D se atualizam ao vivo, e cada mudança de tamanho é classificada de novo.',
      alt: (to: string, breach: string) => `O painel mostra o implante alargado para ${to} mm e classificado como ${breach}: os rótulos flutuantes o colocam perto demais do dente adjacente, enquanto o canal continua SEGURO.`,
    },
    cut: {
      word: 'Corte.',
      caption: 'O exame em resolução total no corte, com os contornos da segmentação por cima.',
      body: 'Corte a anatomia sólida em qualquer plano, axial, sagital ou livre, e o exame acompanha o corte.',
      alt: 'Um corte sagital do CBCT segurado entre as mãos: o exame em cinza, com os contornos coloridos da segmentação e o canal em vermelho por cima.',
    },
  },
  watchPart: 'Assistir a este trecho',
  film: {
    title: 'O vídeo completo',
    meta: (length: string, chapters: number) => `${length}, ${chapters} capítulos, sem som, texto em inglês`,
    card: (length: string) => `Assistir ao vídeo completo (${length})`,
    index: 'Capítulos do vídeo',
  },
  card: {
    title: 'ImplantPlan VR',
    text: 'Para Meta Quest 3, Quest 3S e Quest Pro. A instalação é feita a partir de um computador, e o headset é pareado com a sua conta por um código de uso único.',
    version: (version: string, mb: string) => `Versão ${version} · ${mb} MB`,
    button: 'Instalar o ImplantPlan VR',
    buttonSoon: 'Conhecer o ImplantPlan VR',
    soon: 'O download abre em breve na página dele.',
    alt: 'O painel de boas-vindas do ImplantPlan VR no headset, com a sessão iniciada, o botão para continuar e a escolha de ambiente.',
  },
} satisfies VrStrings;

export const vr: Record<Locale, VrStrings> = { en, es, 'pt-br': ptBR };
