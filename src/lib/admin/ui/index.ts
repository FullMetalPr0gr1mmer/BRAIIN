import { aiConfigUi } from './aiConfig';
import { aiQuestionsUi } from './aiQuestions';
import { aiStylesUi } from './aiStyles';
import { blogUi } from './blog';
import { categoriesUi } from './categories';
import { certificationsUi } from './certifications';
import { clientsUi } from './clients';
import { disciplinesUi } from './disciplines';
import { integrationsUi } from './integrations';
import { mediaUi } from './media';
import { navigationUi } from './navigation';
import { pagesUi } from './pages';
import { portfolioUi } from './portfolio';
import { profileUi } from './profile';
import { redirectsUi } from './redirects';
import { sectionsUi } from './sections';
import { sectorsUi } from './sectors';
import { seoUi } from './seo';
import { serviceCasesUi } from './serviceCases';
import { servicesUi } from './services';
import { settingsUi } from './settings';
import { statisticsUi } from './statistics';
import { teamUi } from './team';
import { testimonialsUi } from './testimonials';
import { themesUi } from './themes';
import type { ResourceUi, SingletonUi } from './types';

export type {
  ColumnDef,
  FieldDef,
  FieldKind,
  RelationDef,
  RelationFilterValue,
  ResourceUi,
  SingletonUi,
  SyncActionDef,
} from './types';
export { columnOf, relationParams } from './fields';

// Field descriptors for the generic admin table + form islands.
//
// One data-driven description per resource instead of sixteen bespoke React forms. The
// alternative — a hand-written editor per entity — is where bilingual fields quietly
// become monolingual ones: someone adds a `title` input, ships it, and the Arabic half
// is missing until CI's `meta_*_ar` gate or a reader notices. Here "bilingual" is a
// FIELD KIND, so both inputs appear together or neither does.
//
// This file is presentation only. Nothing here is a security boundary: the server
// re-validates every field against `packages/schemas/admin.ts`, and a field omitted
// here simply cannot be edited in the UI — it does not become writable by other means.
//
// Admin v2 (W0): one module per editor in this directory (the shapes in ./types.ts, the
// shared helpers in ./fields.ts), registered below. A new entity is its module and one
// line in each place it is listed here. Forms, fields and pages import all of it through
// src/lib/admin/uiSchema.ts.

/** Every collection's editor by its admin slug (/admin/<slug>, /api/admin/<slug>). Sorted. */
export const RESOURCE_UI: Record<string, ResourceUi> = {
  'ai-questions': aiQuestionsUi,
  'ai-styles': aiStylesUi,
  blog: blogUi,
  categories: categoriesUi,
  certifications: certificationsUi,
  clients: clientsUi,
  disciplines: disciplinesUi,
  media: mediaUi,
  navigation: navigationUi,
  pages: pagesUi,
  portfolio: portfolioUi,
  redirects: redirectsUi,
  sections: sectionsUi,
  sectors: sectorsUi,
  'service-cases': serviceCasesUi,
  services: servicesUi,
  statistics: statisticsUi,
  team: teamUi,
  testimonials: testimonialsUi,
  themes: themesUi,
};

export function uiFor(slug: string): ResourceUi {
  const ui = RESOURCE_UI[slug];
  if (!ui) throw new Error(`No admin UI schema for resource '${slug}'`);
  return ui;
}

// ── Singleton config surfaces ───────────────────────────────────────────────────
// One row per tenant, edited through GET/PATCH rather than a collection. Same field
// descriptors, so `SingletonForm` and `ResourceForm` render identical controls and a
// bilingual field cannot end up half-implemented on one of the two paths.

/** Every singleton's editor by the key a page hands SingletonForm. Sorted. */
export const SINGLETON_UI: Record<string, SingletonUi> = {
  'ai-config': aiConfigUi,
  integrations: integrationsUi,
  profile: profileUi,
  seo: seoUi,
  settings: settingsUi,
};

export function singletonFor(key: string): SingletonUi {
  const ui = SINGLETON_UI[key];
  if (!ui) throw new Error(`No admin UI schema for singleton '${key}'`);
  return ui;
}
