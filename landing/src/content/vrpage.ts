/* Copy for /vr/, the ImplantPlan VR download page, in the three locales.
 *
 * Every figure the page shows about the build (version, size, SHA-256) comes from
 * src/generated/apk.json at render time; nothing here carries one. The two numbers that do
 * live here are cited where they are defined below.
 *
 * Register and terms follow the shared lock (vendor/landing-ui/src/i18n.ts): ES addresses
 * the reader as usted and says "visor"; PT-BR says "headset" and "celular". Meta's own UI
 * names (Developer Mode, Unknown Sources, Allow) are given in each locale's Horizon OS
 * wording, the same wording the sibling site's get-app page uses. The ImplantPlan
 * dashboard is English-only (web/index.html lang="en"), so its labels stay English in every
 * locale and are marked lang="en" by the component.
 */
import type { Locale } from '@dicomsegvr/landing-ui/types';

/** api/routes/pair.py:65, CODE_TTL_MINUTES. The landing image is built from landing/ alone,
 *  so the API source is not there to read at build time; scripts/number-sources.json pins it. */
export const PAIR_CODE_MINUTES = 5;

/** The dashboard path to the pairing code, exactly as labelled in the web app: the Settings
 *  tab (web/index.html:48), the Headsets panel (:394) and its button (web/app.js:1927). */
export const PAIR_UI = ['Settings', 'Headsets', 'Connect a headset'] as const;

/** Meta's Developer Mode guide, the same URL the sibling site's get-app page links. */
export const META_DEV_MODE = 'https://developers.meta.com/horizon/documentation/android-apps/enable-developer-mode/';

const en = {
  title: 'ImplantPlan VR for Meta Quest 3, 3S and Pro · ImplantPlan',
  /** Meta description. It may only promise the build facts when the page shows them. */
  description: {
    available: 'Install ImplantPlan VR on Meta Quest 3, Quest 3S or Quest Pro from a computer. Version, size and SHA-256 are on the page.',
    soon: 'How ImplantPlan VR installs on Meta Quest 3, Quest 3S or Quest Pro from a computer, and how it pairs with your account. The download opens here shortly.',
  },
  h1: 'ImplantPlan VR',
  lead: 'Your ImplantPlan cases in a Meta Quest headset. Place, tilt and resize an implant by hand; the server grades every change, the same way it does in the browser.',
  mediaAlt: 'The ImplantPlan VR welcome panel inside a Meta Quest headset, over a lake at sunset.',
  facts: {
    version: 'Version',
    size: 'Size',
    bytes: (n: string) => `${n} bytes`,
    sha: 'SHA-256',
    headsets: 'Headsets',
    headsetsValue: 'Meta Quest 3, Quest 3S, Quest Pro',
    notSupported: 'Not supported: Meta Quest 2.',
    need: 'You need',
    needValue: 'A computer (Windows, macOS or Linux), a USB-C cable that carries data, Developer Mode on the headset (a free Meta developer account) and an ImplantPlan account; the free trial works.',
  },
  copy: { idle: 'Copy', done: 'Copied', sha: 'Copy the SHA-256', command: 'Copy the command' },
  newTab: '(opens in a new tab)',
  download: {
    button: (mb: string) => `Download the APK · ${mb}\u00a0MB`,
    phoneButton: (mb: string) => `Download on this phone anyway (${mb}\u00a0MB)`,
    phoneNote: 'This file is for your computer, not your phone.',
    soon: 'The download opens here shortly.',
  },
  phone: {
    title: 'On a phone right now?',
    text: "The APK installs onto the headset from a computer, so it can't go on a phone. From here you can:",
    share: 'Share this page',
    email: 'Email me the link',
    copyLink: 'Copy link',
    copied: 'Link copied',
    mailSubject: 'ImplantPlan VR for Meta Quest',
    mailBody: (url: string) => `ImplantPlan VR installs on a Meta Quest from a computer: ${url}`,
    step1: 'Developer Mode is switched on from the Meta Horizon app on this phone.',
    step1Link: 'Do step 1 now',
    account: 'Create your account now; the headset opens the cases in your workspace.',
  },
  quest: "You're in the headset's browser. Installing needs a computer, so open this page there:",
  install: {
    title: 'Install it from a computer',
    /** Shown in the adb command while there is no build to name. */
    genericFile: 'ImplantPlanVR.apk',
    devMode: {
      title: 'Turn on Developer Mode',
      text: "In the Meta Horizon app on your phone, open your headset's settings, then Developer Mode.",
      guide: "Meta's guide to Developer Mode",
    },
    connect: {
      title: 'Connect the headset',
      text: 'Use a USB-C cable that carries data. Put the headset on and choose Allow when it asks to allow USB debugging.',
    },
    apk: {
      title: 'Install the APK',
      text: 'With Meta Quest Developer Hub (drag the APK onto the headset), SideQuest or adb:',
    },
    open: {
      title: 'Open it on the headset',
      text: 'Open Library, choose Unknown Sources and start ImplantPlan VR.',
    },
  },
  verify: {
    summary: 'Check the file',
    text: 'Run the command for your system in the folder the APK is in. The result must match the SHA-256 on this page.',
    windows: 'Windows (PowerShell)',
  },
  pair: {
    title: 'Pair it with your workspace',
    /** `{path}` becomes the dashboard labels in PAIR_UI. */
    open: 'In ImplantPlan, open {path}.',
    code: (minutes: number) => `A one-time code and a QR code appear for ${minutes} minutes.`,
    look: 'Put on the headset, open ImplantPlan VR and look at the code, or type it on the sign-in panel. It works once.',
    revoke: 'Paired headsets are listed in the same panel, where you can revoke them.',
  },
  notice: 'Research and education only · Not a medical device · Not for diagnostic use',
};

export type VrStrings = typeof en;

const es = {
  title: 'ImplantPlan VR para Meta Quest 3, 3S y Pro · ImplantPlan',
  description: {
    available: 'Instale ImplantPlan VR en Meta Quest 3, Quest 3S o Quest Pro desde un ordenador. La versión, el tamaño y el SHA-256 están en esta página.',
    soon: 'Cómo se instala ImplantPlan VR en Meta Quest 3, Quest 3S o Quest Pro desde un ordenador y cómo se vincula a su cuenta. La descarga se abre aquí en breve.',
  },
  h1: 'ImplantPlan VR',
  lead: 'Sus casos de ImplantPlan en un visor Meta Quest. Coloque, incline y redimensione un implante con las manos; el servidor clasifica cada cambio, igual que en el navegador.',
  mediaAlt: 'El panel de bienvenida de ImplantPlan VR dentro de un visor Meta Quest, sobre un lago al atardecer.',
  facts: {
    version: 'Versión',
    size: 'Tamaño',
    bytes: n => `${n} bytes`,
    sha: 'SHA-256',
    headsets: 'Visores',
    headsetsValue: 'Meta Quest 3, Quest 3S, Quest Pro',
    notSupported: 'No compatible: Meta Quest 2.',
    need: 'Necesita',
    needValue: 'Un ordenador (Windows, macOS o Linux), un cable USB-C que admita transferencia de datos, el modo desarrollador activado en el visor (con una cuenta de desarrollador de Meta, gratuita) y una cuenta de ImplantPlan; la prueba gratuita sirve.',
  },
  copy: { idle: 'Copiar', done: 'Copiado', sha: 'Copiar el SHA-256', command: 'Copiar el comando' },
  newTab: '(se abre en una pestaña nueva)',
  download: {
    button: mb => `Descargar el APK · ${mb}\u00a0MB`,
    phoneButton: mb => `Descargar en este teléfono de todos modos (${mb}\u00a0MB)`,
    phoneNote: 'Este archivo es para su ordenador, no para su teléfono.',
    soon: 'La descarga se abre aquí en breve.',
  },
  phone: {
    title: '¿Está en un teléfono ahora?',
    text: 'El APK se instala en el visor desde un ordenador, así que no se puede instalar en un teléfono. Desde aquí puede:',
    share: 'Compartir esta página',
    email: 'Enviarme el enlace por correo',
    copyLink: 'Copiar el enlace',
    copied: 'Enlace copiado',
    mailSubject: 'ImplantPlan VR para Meta Quest',
    mailBody: url => `ImplantPlan VR se instala en un Meta Quest desde un ordenador: ${url}`,
    step1: 'El modo desarrollador se activa desde la aplicación Meta Horizon de este teléfono.',
    step1Link: 'Haga ahora el paso 1',
    account: 'Cree su cuenta ahora; el visor abre los casos de su espacio de trabajo.',
  },
  quest: 'Está en el navegador del visor. La instalación necesita un ordenador; abra esta página en él:',
  install: {
    title: 'Instálelo desde un ordenador',
    genericFile: 'ImplantPlanVR.apk',
    devMode: {
      title: 'Active el modo desarrollador',
      text: 'En la aplicación Meta Horizon de su teléfono, abra la configuración de su visor y después Modo desarrollador.',
      guide: 'Guía de Meta sobre el modo desarrollador',
    },
    connect: {
      title: 'Conecte el visor',
      text: 'Use un cable USB-C que admita transferencia de datos. Póngase el visor y elija Permitir cuando le pregunte si desea permitir la depuración por USB.',
    },
    apk: {
      title: 'Instale el APK',
      text: 'Con Meta Quest Developer Hub (arrastre el APK al visor), SideQuest o adb:',
    },
    open: {
      title: 'Ábralo en el visor',
      text: 'Abra la Biblioteca, elija Fuentes desconocidas e inicie ImplantPlan VR.',
    },
  },
  verify: {
    summary: 'Compruebe el archivo',
    text: 'Ejecute el comando de su sistema en la carpeta donde está el APK. El resultado debe coincidir con el SHA-256 de esta página.',
    windows: 'Windows (PowerShell)',
  },
  pair: {
    title: 'Vincúlelo a su espacio de trabajo',
    open: 'En ImplantPlan, abra {path}.',
    code: minutes => `Aparecen un código de un solo uso y un código QR durante ${minutes} minutos.`,
    look: 'Póngase el visor, abra ImplantPlan VR y mire el código, o escríbalo en el panel de inicio de sesión. Funciona una sola vez.',
    revoke: 'Los visores vinculados aparecen en ese mismo panel, donde puede revocarlos.',
  },
  notice: 'Solo para investigación y docencia · No es un producto sanitario · No apto para uso diagnóstico',
} satisfies VrStrings;

const ptBR = {
  title: 'ImplantPlan VR para Meta Quest 3, 3S e Pro · ImplantPlan',
  description: {
    available: 'Instale o ImplantPlan VR no Meta Quest 3, Quest 3S ou Quest Pro a partir de um computador. Versão, tamanho e SHA-256 estão nesta página.',
    soon: 'Como o ImplantPlan VR é instalado no Meta Quest 3, Quest 3S ou Quest Pro a partir de um computador e como ele se vincula à sua conta. O download abre aqui em breve.',
  },
  h1: 'ImplantPlan VR',
  lead: 'Seus casos do ImplantPlan em um headset Meta Quest. Posicione, incline e redimensione um implante com as mãos; o servidor classifica cada alteração, do mesmo jeito que no navegador.',
  mediaAlt: 'O painel de boas-vindas do ImplantPlan VR dentro de um headset Meta Quest, sobre um lago ao pôr do sol.',
  facts: {
    version: 'Versão',
    size: 'Tamanho',
    bytes: n => `${n} bytes`,
    sha: 'SHA-256',
    headsets: 'Headsets',
    headsetsValue: 'Meta Quest 3, Quest 3S, Quest Pro',
    notSupported: 'Não compatível: Meta Quest 2.',
    need: 'Você precisa de',
    needValue: 'Um computador (Windows, macOS ou Linux), um cabo USB-C que transmita dados, o Modo de desenvolvedor ativado no headset (com uma conta de desenvolvedor da Meta, gratuita) e uma conta do ImplantPlan; o teste gratuito serve.',
  },
  copy: { idle: 'Copiar', done: 'Copiado', sha: 'Copiar o SHA-256', command: 'Copiar o comando' },
  newTab: '(abre em uma nova aba)',
  download: {
    button: mb => `Baixar o APK · ${mb}\u00a0MB`,
    phoneButton: mb => `Baixar neste celular mesmo assim (${mb}\u00a0MB)`,
    phoneNote: 'Este arquivo é para o seu computador, não para o celular.',
    soon: 'O download abre aqui em breve.',
  },
  phone: {
    title: 'Está no celular agora?',
    text: 'O APK é instalado no headset a partir de um computador, então não dá para instalá-lo no celular. Daqui você pode:',
    share: 'Compartilhar esta página',
    email: 'Enviar o link para o meu e-mail',
    copyLink: 'Copiar o link',
    copied: 'Link copiado',
    mailSubject: 'ImplantPlan VR para Meta Quest',
    mailBody: url => `O ImplantPlan VR é instalado em um Meta Quest a partir de um computador: ${url}`,
    step1: 'O Modo de desenvolvedor é ativado pelo app Meta Horizon deste celular.',
    step1Link: 'Faça o passo 1 agora',
    account: 'Crie sua conta agora; o headset abre os casos do seu espaço de trabalho.',
  },
  quest: 'Você está no navegador do headset. A instalação precisa de um computador; abra esta página nele:',
  install: {
    title: 'Instale a partir de um computador',
    genericFile: 'ImplantPlanVR.apk',
    devMode: {
      title: 'Ative o Modo de desenvolvedor',
      text: 'No app Meta Horizon do seu celular, abra as configurações do headset e depois Modo de desenvolvedor.',
      guide: 'Guia da Meta sobre o Modo de desenvolvedor',
    },
    connect: {
      title: 'Conecte o headset',
      text: 'Use um cabo USB-C que transmita dados. Coloque o headset e escolha Permitir quando ele perguntar se deseja permitir a depuração USB.',
    },
    apk: {
      title: 'Instale o APK',
      text: 'Com o Meta Quest Developer Hub (arraste o APK para o headset), o SideQuest ou o adb:',
    },
    open: {
      title: 'Abra no headset',
      text: 'Abra a Biblioteca, escolha Fontes desconhecidas e inicie o ImplantPlan VR.',
    },
  },
  verify: {
    summary: 'Confira o arquivo',
    text: 'Execute o comando do seu sistema na pasta onde está o APK. O resultado deve coincidir com o SHA-256 desta página.',
    windows: 'Windows (PowerShell)',
  },
  pair: {
    title: 'Vincule ao seu espaço de trabalho',
    open: 'No ImplantPlan, abra {path}.',
    code: minutes => `Um código de uso único e um QR code aparecem por ${minutes} minutos.`,
    look: 'Coloque o headset, abra o ImplantPlan VR e olhe para o código, ou digite-o no painel de login. Ele funciona uma única vez.',
    revoke: 'Os headsets vinculados aparecem no mesmo painel, onde você pode revogá-los.',
  },
  notice: 'Somente pesquisa e ensino · Não é um dispositivo médico · Não destinado a uso diagnóstico',
} satisfies VrStrings;

export const vrpage: Record<Locale, VrStrings> = { en, es, 'pt-br': ptBR };
