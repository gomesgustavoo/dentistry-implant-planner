import type { Locale } from './types';

/**
 * Interface strings shared by both sites. Page content lives in each site's
 * `src/content/project.<locale>.ts`; only the words that belong to the layout are here.
 *
 * Terminology is fixed, and it is what a reviewer checks first:
 *
 *   EN                         ES                               PT-BR
 *   inferior alveolar canal    conducto dentario inferior       canal mandibular
 *   implant                    implante                         implante
 *   edentulous site            brecha edéntula                  área edêntula
 *   alveolar crest             cresta alveolar                  crista alveolar
 *   safety margin              margen de seguridad              margem de segurança
 *   error budget               presupuesto de error             orçamento de erro
 *   CLEAR / TIGHT / BREACH     SEGURO / AJUSTADO / INVADE       SEGURO / JUSTO / INVADE
 *   NOT GRADED                 SIN GRADO                        SEM GRAU
 *   held-out set               conjunto reservado               conjunto reservado
 *   segmentation               segmentación                     segmentação
 *   Not a medical device       No es un producto sanitario      Não é um dispositivo médico
 *
 * Model and metric names (nnU-Net, U-Mamba2, Dice, HD95, NSD, p95, FDI, CBCT, DICOM,
 * NIfTI, RTSTRUCT, STL) are never translated.
 */
export const LOCALES: Locale[] = ['en', 'es', 'pt-br'];

export const LOCALE_META: Record<Locale, { html: string; og: string; short: string; name: string }> = {
  en: { html: 'en', og: 'en_US', short: 'EN', name: 'English' },
  es: { html: 'es', og: 'es_ES', short: 'ES', name: 'Español' },
  'pt-br': { html: 'pt-BR', og: 'pt_BR', short: 'PT', name: 'Português (Brasil)' },
};

/** `/engineering/` in English is `/es/engineering/` in Spanish. */
export function localePath(locale: Locale, path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return locale === 'en' ? clean : `/${locale}${clean}`;
}

/** Astro `getStaticPaths` for a `[...lang]` route: English at the root. */
export function localeStaticPaths() {
  return LOCALES.map(locale => ({ params: { lang: locale === 'en' ? undefined : locale }, props: { locale } }));
}

/** 25 → "0:25" */
export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

type Strings = typeof en;

const en = {
  skip: 'Skip to content',
  nav: {
    annotation: 'A personal project', home: (name: string) => `${name} home`,
    open: 'Open menu', close: 'Close menu', primary: 'Primary', language: 'Language',
    project: 'The project', engineering: 'Engineering', pricing: 'Pricing', creator: 'Creator',
    app: 'Open the app',
  },
  hero: {
    explore: 'Explore the project', app: 'Open the app', author: 'A personal project by',
    research: 'Research and education only · Not for diagnostic use', interactive: 'Interactive 3D', rail: 'Designed and engineered end to end',
  },
  landing: {
    practice: '01 / In practice',
    behind: '02 / Behind the interface',
    systemTitle: ['A working system.', 'Every layer connected.'] as [string, string],
    systemText: 'I built it end to end, from the data pipeline to the interface. These are the engineering decisions behind it.',
    technologies: 'Technologies',
    notesLead: 'Architecture, implementation details, and lessons learned.',
    notes: 'Read the engineering notes', source: 'View the source on GitHub',
    tryIt: '03 / Try it yourself', tryTitle: 'Explore with your own scan.', usd: 'All prices in USD, billed monthly.',
    start: 'Start here', month: '/ month',
    questions: '04 / Questions', questionsTitle: ['Before you', 'get started.'] as [string, string], deeper: 'Go deeper into the project',
    person: '05 / The person behind the project', builtBy: ['Built by', 'Gustavo Formento.'] as [string, string],
    intro: 'I turn complex imaging problems into software people can explore.',
    linkedin: 'Connect on LinkedIn', github: 'GitHub',
    explore: (name: string) => `Explore ${name}`,
    headset: 'Continue the experience on your headset.',
    watch: 'Watch the demonstration',
  },
  media: {
    badge: 'On Brazilian television', play: (title: string, at: string) => `Play ${title}, starting at ${at}`,
    watch: 'Watch the demonstration', from: 'From', full: 'Full report',
  },
  footer: {
    also: 'Also by Gustavo:', top: 'Back to top', legal: 'Legal',
    notice: 'Research and educational use only. Not a medical device.',
    privacy: 'Privacy', terms: 'Terms', support: 'Support',
  },
  engineering: {
    title: (name: string) => `${name} — Engineering notes · Gustavo Formento`,
    back: (name: string) => `← Back to ${name}`, eyebrow: 'An engineering notebook / Gustavo Formento',
    heading: (name: string) => [`How ${name}`, 'comes together.'] as [string, string],
    source: 'Explore the source', app: 'Open the app', backProject: '← Back to the project', discuss: 'Discuss the work on LinkedIn',
  },
  legal: {
    back: '← Back to the site',
    translated: 'This translation is provided for convenience. If it differs from the English version, the English version prevails.',
    english: 'Read the English version',
  },
  runtime: {
    openMenu: 'Open menu', closeMenu: 'Close menu', video: 'Video demonstration',
    toothIdle: 'Select a tooth to see what the segmentation found.',
    toothAbsent: 'No label produced here',
    component: 'connected component', components: 'connected components',
  },
  hero3d: {
    clear: 'CLEAR', tight: 'TIGHT', breach: 'BREACH', no_verdict: 'NOT GRADED',
    spoken: { clear: 'clear', tight: 'tight', breach: 'breach', no_verdict: 'not graded' },
    readoutLabel: 'Clearance to the inferior alveolar canal',
    noCanal: 'no canal at this site',
    sub: '{measured} mm measured − {p95} mm error budget = {graded} mm against a {margin} mm margin',
    depth: 'Platform {depth} mm below the crest',
    live: 'Clearance to the inferior alveolar canal: {level}, {mm} millimeters.',
    fixture: 'Titanium implant · {d} × {l} mm',
    envelope: 'Safety envelope · {r} mm',
    envelopeMeta: '{margin} mm margin + {p95} mm p95',
    structure: 'Structure',
    fallbackLabel: 'Example from the application',
    fallback: 'Measured by the app at FDI 36 on a scan held out of training. This is a saved example; the interactive scene is unavailable or still loading.',
    names: {
      mandible: 'Mandible', canal: 'Inferior alveolar canal',
      tooth_45: 'Lower right second premolar', tooth_47: 'Lower right second molar',
    } as Record<string, string>,
  },
};

const es: Strings = {
  skip: 'Saltar al contenido',
  nav: {
    annotation: 'Un proyecto personal', home: name => `Inicio de ${name}`,
    open: 'Abrir menú', close: 'Cerrar menú', primary: 'Principal', language: 'Idioma',
    project: 'El proyecto', engineering: 'Ingeniería', pricing: 'Precios', creator: 'Autor',
    app: 'Abrir la aplicación',
  },
  hero: {
    explore: 'Explorar el proyecto', app: 'Abrir la aplicación', author: 'Un proyecto personal de',
    research: 'Solo para investigación y docencia · No apto para uso diagnóstico', interactive: '3D interactivo', rail: 'Diseñado y desarrollado de principio a fin',
  },
  landing: {
    practice: '01 / En la práctica',
    behind: '02 / Detrás de la interfaz',
    systemTitle: ['Un sistema que funciona.', 'Cada capa conectada.'],
    systemText: 'Lo construí de principio a fin, desde el procesamiento de datos hasta la interfaz. Estas son las decisiones de ingeniería que lo sostienen.',
    technologies: 'Tecnologías',
    notesLead: 'Arquitectura, detalles de implementación y lecciones aprendidas.',
    notes: 'Leer las notas de ingeniería', source: 'Ver el código fuente en GitHub',
    tryIt: '03 / Pruébelo', tryTitle: 'Explore con su propio estudio.', usd: 'Todos los precios en USD, con facturación mensual.',
    start: 'Empiece aquí', month: '/ mes',
    questions: '04 / Preguntas', questionsTitle: ['Antes de', 'empezar.'], deeper: 'Profundizar en el proyecto',
    person: '05 / La persona detrás del proyecto', builtBy: ['Creado por', 'Gustavo Formento.'],
    intro: 'Convierto problemas complejos de imagen médica en software que cualquiera puede explorar.',
    linkedin: 'Conectar en LinkedIn', github: 'GitHub',
    explore: name => `Explorar ${name}`,
    headset: 'Continúe la experiencia en su visor.',
    watch: 'Ver la demostración',
  },
  media: {
    badge: 'En la televisión brasileña', play: (title, at) => `Reproducir ${title} desde ${at}`,
    watch: 'Ver la demostración', from: 'Desde', full: 'Reportaje completo',
  },
  footer: {
    also: 'También de Gustavo:', top: 'Volver arriba', legal: 'Legal',
    notice: 'Solo para uso en investigación y docencia. No es un producto sanitario.',
    privacy: 'Privacidad', terms: 'Condiciones', support: 'Soporte',
  },
  engineering: {
    title: name => `${name} — Notas de ingeniería · Gustavo Formento`,
    back: name => `← Volver a ${name}`, eyebrow: 'Un cuaderno de ingeniería / Gustavo Formento',
    heading: name => [`Cómo se construye`, `${name}.`],
    source: 'Explorar el código fuente', app: 'Abrir la aplicación', backProject: '← Volver al proyecto', discuss: 'Comentar el trabajo en LinkedIn',
  },
  legal: {
    back: '← Volver al sitio',
    translated: 'Esta traducción se ofrece por comodidad. Si difiere de la versión en inglés, prevalece la versión en inglés.',
    english: 'Leer la versión en inglés',
  },
  runtime: {
    openMenu: 'Abrir menú', closeMenu: 'Cerrar menú', video: 'Demostración en vídeo',
    toothIdle: 'Seleccione un diente para ver lo que encontró la segmentación.',
    toothAbsent: 'No se generó ninguna etiqueta aquí',
    component: 'componente conexo', components: 'componentes conexos',
  },
  hero3d: {
    clear: 'SEGURO', tight: 'AJUSTADO', breach: 'INVADE', no_verdict: 'SIN GRADO',
    spoken: { clear: 'seguro', tight: 'ajustado', breach: 'invade el margen', no_verdict: 'sin grado' },
    readoutLabel: 'Distancia al conducto dentario inferior',
    noCanal: 'no hay conducto en este sitio',
    sub: '{measured} mm medidos − {p95} mm de presupuesto de error = {graded} mm frente a un margen de {margin} mm',
    depth: 'Plataforma {depth} mm por debajo de la cresta',
    live: 'Distancia al conducto dentario inferior: {level}, {mm} milímetros.',
    fixture: 'Implante de titanio · {d} × {l} mm',
    envelope: 'Envolvente de seguridad · {r} mm',
    envelopeMeta: 'margen de {margin} mm + p95 de {p95} mm',
    structure: 'Estructura',
    fallbackLabel: 'Ejemplo de la aplicación',
    fallback: 'Medido por la aplicación en el FDI 36 de un estudio excluido del entrenamiento. Es un ejemplo guardado; la escena interactiva no está disponible o aún se está cargando.',
    names: {
      mandible: 'Mandíbula', canal: 'Conducto dentario inferior',
      tooth_45: 'Segundo premolar inferior derecho', tooth_47: 'Segundo molar inferior derecho',
    },
  },
};

const ptBR: Strings = {
  skip: 'Pular para o conteúdo',
  nav: {
    annotation: 'Um projeto pessoal', home: name => `Início do ${name}`,
    open: 'Abrir menu', close: 'Fechar menu', primary: 'Principal', language: 'Idioma',
    project: 'O projeto', engineering: 'Engenharia', pricing: 'Preços', creator: 'Autor',
    app: 'Abrir o aplicativo',
  },
  hero: {
    explore: 'Explorar o projeto', app: 'Abrir o aplicativo', author: 'Um projeto pessoal de',
    research: 'Somente pesquisa e ensino · Não destinado a uso diagnóstico', interactive: '3D interativo', rail: 'Projetado e desenvolvido de ponta a ponta',
  },
  landing: {
    practice: '01 / Na prática',
    behind: '02 / Por trás da interface',
    systemTitle: ['Um sistema que funciona.', 'Cada camada conectada.'],
    systemText: 'Construí tudo de ponta a ponta, do processamento de dados à interface. Estas são as decisões de engenharia por trás dele.',
    technologies: 'Tecnologias',
    notesLead: 'Arquitetura, detalhes de implementação e lições aprendidas.',
    notes: 'Ler as notas de engenharia', source: 'Ver o código-fonte no GitHub',
    tryIt: '03 / Experimente', tryTitle: 'Explore com o seu próprio exame.', usd: 'Todos os preços em USD, cobrança mensal.',
    start: 'Comece aqui', month: '/ mês',
    questions: '04 / Perguntas', questionsTitle: ['Antes de', 'começar.'], deeper: 'Aprofundar no projeto',
    person: '05 / A pessoa por trás do projeto', builtBy: ['Criado por', 'Gustavo Formento.'],
    intro: 'Transformo problemas complexos de imagem médica em software que qualquer pessoa pode explorar.',
    linkedin: 'Conectar no LinkedIn', github: 'GitHub',
    explore: name => `Explorar o ${name}`,
    headset: 'Continue a experiência no seu headset.',
    watch: 'Assistir à demonstração',
  },
  media: {
    badge: 'Na televisão brasileira', play: (title, at) => `Reproduzir ${title} a partir de ${at}`,
    watch: 'Assistir à demonstração', from: 'A partir de', full: 'Reportagem completa',
  },
  footer: {
    also: 'Também de Gustavo:', top: 'Voltar ao topo', legal: 'Legal',
    notice: 'Somente para uso em pesquisa e ensino. Não é um dispositivo médico.',
    privacy: 'Privacidade', terms: 'Termos', support: 'Suporte',
  },
  engineering: {
    title: name => `${name} — Notas de engenharia · Gustavo Formento`,
    back: name => `← Voltar ao ${name}`, eyebrow: 'Um caderno de engenharia / Gustavo Formento',
    heading: name => [`Como o ${name}`, 'é construído.'],
    source: 'Explorar o código-fonte', app: 'Abrir o aplicativo', backProject: '← Voltar ao projeto', discuss: 'Comentar o trabalho no LinkedIn',
  },
  legal: {
    back: '← Voltar ao site',
    translated: 'Esta tradução é oferecida por conveniência. Em caso de divergência, prevalece a versão em inglês.',
    english: 'Ler a versão em inglês',
  },
  runtime: {
    openMenu: 'Abrir menu', closeMenu: 'Fechar menu', video: 'Demonstração em vídeo',
    toothIdle: 'Selecione um dente para ver o que a segmentação encontrou.',
    toothAbsent: 'Nenhum rótulo foi gerado aqui',
    component: 'componente conexo', components: 'componentes conexos',
  },
  hero3d: {
    clear: 'SEGURO', tight: 'JUSTO', breach: 'INVADE', no_verdict: 'SEM GRAU',
    spoken: { clear: 'seguro', tight: 'justo', breach: 'invade a margem', no_verdict: 'sem grau' },
    readoutLabel: 'Distância ao canal mandibular',
    noCanal: 'não há canal neste local',
    sub: '{measured} mm medidos − {p95} mm de orçamento de erro = {graded} mm contra uma margem de {margin} mm',
    depth: 'Plataforma {depth} mm abaixo da crista',
    live: 'Distância ao canal mandibular: {level}, {mm} milímetros.',
    fixture: 'Implante de titânio · {d} × {l} mm',
    envelope: 'Envelope de segurança · {r} mm',
    envelopeMeta: 'margem de {margin} mm + p95 de {p95} mm',
    structure: 'Estrutura',
    fallbackLabel: 'Exemplo do aplicativo',
    fallback: 'Medido pelo aplicativo no FDI 36 de um exame excluído do treinamento. Este é um exemplo salvo; a cena interativa não está disponível ou ainda está carregando.',
    names: {
      mandible: 'Mandíbula', canal: 'Canal mandibular',
      tooth_45: 'Segundo pré-molar inferior direito', tooth_47: 'Segundo molar inferior direito',
    },
  },
};

export const STRINGS: Record<Locale, Strings> = { en, es, 'pt-br': ptBR };
export const t = (locale: Locale) => STRINGS[locale];

/** Localized decimal: 3.43 → "3,43" in Spanish and Portuguese. */
export function decimal(locale: Locale, value: number, digits = 2): string {
  return new Intl.NumberFormat(LOCALE_META[locale].html, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}
