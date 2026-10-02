import type { Locale } from '@dicomsegvr/landing-ui/types';

/**
 * Words for the lower half of the landing: Ledger, Pricing, Faq, Creator and TvClip.
 *
 * Only words live here. Every figure is a `{token}` that the component fills from its source
 * at build time (the engineering notes, the baked safety constants, `project.<l>.ts`), so a
 * translation can move a number inside its sentence but can never retype it. Interface
 * phrases the shared UI already translates (the engineering-notes link, "/ month", the USD
 * line, the play label) are taken from `t(locale)` in the components and are not repeated.
 *
 * Terminology follows the lock in `vendor/landing-ui/src/i18n.ts`: conducto dentario
 * inferior / canal mandibular, margen de seguridad / margem de segurança, presupuesto de
 * error / orçamento de erro, conjunto reservado. Spanish is in the usted register, as the
 * shared strings are. Visible copy carries no em or en dash and at most one middle dot.
 */

const en = {
  ledger: {
    title: 'Each figure here links to the measurement behind it.',
    // `lead` in Ledger.astro names the token set in mono; the rest read as plain text.
    rows: {
      dice: {
        text: '{dice} challenge Dice on {scans} held-out scans the base network never saw, within {gap} of the ToothFairy3 challenge winners, trained on a {card} GB card.',
        link: 'The models',
      },
      budget: {
        text: '{p95}, the canal’s inward boundary error at p95 on that set, is subtracted from every canal clearance before it is graded.',
        link: 'The error budget',
      },
      envelope: {
        text: '{envelope} is the safety envelope in the scene above: the {margin} margin plus that {p95}, baked into the page from the planner’s own constants.',
        link: 'The safety envelope',
      },
      serving: {
        text: '{gpu} of GPU time per scan for the two models, behind an API and a job queue.',
        link: 'How it runs in production',
      },
    },
    stack: 'Built with PyTorch, nnU-Net with a U-Mamba2 bottleneck, FastAPI, PostgreSQL, k3s, Cornerstone3D, vtk.js and three.js.',
    licence: 'Code: {mit}. Model weights: {cc}, trained on ToothFairy3.',
  },
  pricing: {
    title: 'Try it on your own scan.',
  },
  faq: {
    title: 'Before you upload a scan.',
    headset: {
      question: 'Do I need a headset?',
      answer: 'No. You upload, plan and read every grade in the browser; segmentation runs on the server’s GPUs. ImplantPlan VR adds Meta Quest 3, Quest 3S and Quest Pro (not Quest 2); it installs from a computer, and a plan saved in the headset opens in the web app.',
    },
    phone: {
      question: 'Can I install ImplantPlan VR from my phone?',
      answer: 'No. It goes onto the headset from a computer over USB. {vr} walks you through it.',
      vr: 'The ImplantPlan VR page',
    },
  },
  creator: {
    personal: 'ImplantPlan is a personal project, unaffiliated with any employer.',
    alsoBy: 'Also by Gustavo: {name}',
  },
  tv: {
    meta: 'On Brazilian television · {language}, from {at}',
    watch: 'Full report on YouTube',
    newTab: '(opens in a new tab)',
  },
};

export type SectionStrings = typeof en;

const es = {
  ledger: {
    title: 'Cada cifra de esta sección enlaza con la medición que la respalda.',
    rows: {
      dice: {
        text: 'Dice del reto de {dice} en un conjunto reservado de {scans} estudios que la red base nunca vio, a {gap} de los ganadores del reto ToothFairy3; se entrenó en una tarjeta de {card} GB.',
        link: 'Los modelos',
      },
      budget: {
        text: '{p95}, el error de contorno hacia dentro del conducto dentario inferior en ese conjunto (p95), se resta de cada distancia al conducto antes de clasificarla.',
        link: 'El presupuesto de error',
      },
      envelope: {
        text: '{envelope} es la envolvente de seguridad de la escena de arriba: el margen de seguridad de {margin} más esos {p95}, fijados en la página a partir de las constantes del propio planificador.',
        link: 'La envolvente de seguridad',
      },
      serving: {
        text: '{gpu} de GPU por estudio para los dos modelos, detrás de una API y una cola de trabajos.',
        link: 'Cómo funciona en producción',
      },
    },
    stack: 'Construido con PyTorch, nnU-Net con un cuello de botella U-Mamba2, FastAPI, PostgreSQL, k3s, Cornerstone3D, vtk.js y three.js.',
    licence: 'Código: {mit}. Pesos del modelo: {cc}, entrenados con ToothFairy3.',
  },
  pricing: {
    title: 'Pruébelo con su propio estudio.',
  },
  faq: {
    title: 'Antes de subir un estudio.',
    headset: {
      question: '¿Necesito un visor?',
      answer: 'No. Usted sube el estudio, planifica y consulta cada veredicto en el navegador; la segmentación se ejecuta en las GPU del servidor. ImplantPlan VR añade Meta Quest 3, Quest 3S y Quest Pro (no Quest 2); se instala desde un ordenador, y un plan guardado en el visor se abre en la aplicación web.',
    },
    phone: {
      question: '¿Puedo instalar ImplantPlan VR desde mi teléfono?',
      answer: 'No. Se instala en el visor desde un ordenador, por USB. {vr} le guía paso a paso.',
      vr: 'La página de ImplantPlan VR',
    },
  },
  creator: {
    personal: 'ImplantPlan es un proyecto personal, sin vínculo con ningún empleador.',
    alsoBy: 'También de Gustavo: {name}',
  },
  tv: {
    meta: 'En la televisión brasileña · {language}, desde {at}',
    watch: 'Reportaje completo en YouTube',
    newTab: '(se abre en una pestaña nueva)',
  },
} satisfies SectionStrings;

const ptBR = {
  ledger: {
    title: 'Cada número desta seção leva à medição que o sustenta.',
    rows: {
      dice: {
        text: 'Dice do desafio de {dice} em um conjunto reservado de {scans} exames que a rede base nunca viu, a {gap} dos vencedores do desafio ToothFairy3; foi treinada em uma placa de {card} GB.',
        link: 'Os modelos',
      },
      budget: {
        text: '{p95}, o erro de contorno para dentro do canal mandibular nesse conjunto (p95), é subtraído de cada distância ao canal antes de ela ser classificada.',
        link: 'O orçamento de erro',
      },
      envelope: {
        text: '{envelope} é o envelope de segurança da cena acima: a margem de segurança de {margin} mais esses {p95}, gravados na página a partir das constantes do próprio planejador.',
        link: 'O envelope de segurança',
      },
      serving: {
        text: '{gpu} de GPU por exame para os dois modelos, por trás de uma API e de uma fila de processamento.',
        link: 'Como roda em produção',
      },
    },
    stack: 'Construído com PyTorch, nnU-Net com bottleneck U-Mamba2, FastAPI, PostgreSQL, k3s, Cornerstone3D, vtk.js e three.js.',
    licence: 'Código: {mit}. Pesos do modelo: {cc}, treinados no ToothFairy3.',
  },
  pricing: {
    title: 'Experimente com o seu próprio exame.',
  },
  faq: {
    title: 'Antes de enviar um exame.',
    headset: {
      question: 'Preciso de um headset?',
      answer: 'Não. Você envia o exame, planeja e lê cada veredito no navegador; a segmentação roda nas GPUs do servidor. O ImplantPlan VR adiciona Meta Quest 3, Quest 3S e Quest Pro (não o Quest 2); ele é instalado a partir de um computador, e um plano salvo no headset abre no aplicativo web.',
    },
    phone: {
      question: 'Posso instalar o ImplantPlan VR pelo celular?',
      answer: 'Não. Ele vai para o headset a partir de um computador, via USB. {vr} mostra o passo a passo.',
      vr: 'A página do ImplantPlan VR',
    },
  },
  creator: {
    personal: 'O ImplantPlan é um projeto pessoal, sem vínculo com nenhum empregador.',
    alsoBy: 'Também de Gustavo: {name}',
  },
  tv: {
    meta: 'Na televisão brasileira · {language}, a partir de {at}',
    watch: 'Reportagem completa no YouTube',
    newTab: '(abre em uma nova aba)',
  },
} satisfies SectionStrings;

export const sections: Record<Locale, SectionStrings> = { en, es, 'pt-br': ptBR };

/** One piece of a filled template: literal text, or the value of a `{token}` (with its key). */
export interface Part { text: string; key?: string }

/**
 * Split a `{token}` template into literal and filled parts, so a component can wrap a figure
 * or a link around the token instead of pasting HTML into a string. An unknown token throws:
 * a translation that names a figure the component does not supply must fail the build, not
 * ship a literal "{gap}" to a reader.
 */
export function parts(template: string, values: Record<string, string>): Part[] {
  return template.split(/(\{\w+\})/).filter(Boolean).map(piece => {
    const key = piece.match(/^\{(\w+)\}$/)?.[1];
    if (!key) return { text: piece };
    if (!(key in values)) throw new Error(`sections.ts: template "${template}" uses {${key}}, which the component does not supply`);
    return { text: values[key], key };
  });
}

/** `parts()` joined back to plain text, for attributes and headings with no markup. */
export const fill = (template: string, values: Record<string, string>) =>
  parts(template, values).map(part => part.text).join('');
