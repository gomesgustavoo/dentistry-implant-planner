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
}
export interface Project {
  id: 'dicomsegvr' | 'implantplan';
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
  repo: string;
  sibling: Link;
  poster: string;
  socialImage: string;
  favicon: string;
  touchIcon: string;
  sceneLabel: string;
  sceneDetail: string;
  sceneHint: string;
  skills: string[];
  demo: { title: string; description: string; steps: Highlight[] };
  highlights: Highlight[];
  plans: Plan[];
  pricingNote: string;
  faq: { question: string; answer: string }[];
  engineeringIntro: string;
  media: Media;
}
