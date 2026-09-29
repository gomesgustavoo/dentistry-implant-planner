import type { Locale, Project } from '@dicomsegvr/landing-ui/types';
import { project as en } from './project.en';
import { project as es } from './project.es';
import { project as ptBR } from './project.pt-br';
import engEn from './engineering.en.html?raw';
import engEs from './engineering.es.html?raw';
import engPt from './engineering.pt-br.html?raw';
import { legal as legalEn } from './legal/legal.en';
import { legal as legalEs } from './legal/legal.es';
import { legal as legalPt } from './legal/legal.pt-br';

export const projects: Record<Locale, Project> = { en, es, 'pt-br': ptBR };
export const engineering: Record<Locale, string> = { en: engEn, es: engEs, 'pt-br': engPt };
type Page = { title: string; description: string; html: string };
type Pages = Record<'privacy' | 'terms', Page>;
const byLocale: Record<Locale, Pages> = { en: legalEn, es: legalEs, 'pt-br': legalPt };
export const legal = {
  privacy: { en: byLocale.en.privacy, es: byLocale.es.privacy, 'pt-br': byLocale['pt-br'].privacy },
  terms: { en: byLocale.en.terms, es: byLocale.es.terms, 'pt-br': byLocale['pt-br'].terms },
} satisfies Record<keyof Pages, Record<Locale, Page>>;
