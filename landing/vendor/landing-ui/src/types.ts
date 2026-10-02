export type Locale = 'en' | 'es' | 'pt-br';
export interface Link { label: string; href: string }
export interface Plan {
  name: string;
  price: string;
  allowance: string;
  features: string[];
  action: Link;
  note: string;
}
export interface Highlight {
  category: string;
  title: string;
  description: string;
  technologies: string[];
}
export interface Media {
  videoId: string;
  start: number;
  title: string;
  caption: string;
  language: string;
  alt: string;
}
/** A recorded demonstration shown in place of the embedded report. */
export interface DemoVideo {
  bar: string;
  badge: string;
  src: string;
  poster: string;
  label: string;
  caption: string;
}
export interface Project {
  id: 'dicomsegvr' | 'implantplan';
  locale: Locale;
  name: string;
  wordmark: [string, string];
  theme: 'dark' | 'light';
  url: string;
  title: string;
  description: string;
  eyebrow: string;
  headline: [string, string];
  primary: Link;
  trial: string;
  /** Public source repository, or '' when the source is not public. */
  repo: string;
  sibling: Link;
  poster: string;
  socialImage: string;
  socialImageAlt: string;
  favicon: string;
  touchIcon: string;
  sceneLabel: string;
  sceneDetail: string;
  sceneHint: string;
  /** Caption pair under a scene that has no live readout. */
  sceneCaption?: [string, string];
  skills: string[];
  demo: { title: string; description: string; steps: Highlight[]; video?: DemoVideo };
  highlights: Highlight[];
  plans: Plan[];
  pricingNote: string;
  faq: { question: string; answer: string }[];
  creatorBio: string;
  related?: { eyebrow: string; title: [string, string]; text: string };
  getApp?: Link & { lead: string };
  engineeringIntro: string;
  license?: { text: string; name: string; href: string; credits: Link };
  media: Media;
  /** Navigation links; '#id' resolves to the home page, '/path/' to the page in this locale. */
  nav?: Link[];
  /** schema.org operatingSystem, when it differs from the default for this project. */
  operatingSystem?: string;
}
