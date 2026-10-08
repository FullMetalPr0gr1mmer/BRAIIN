import type { ResourceConfig } from '../resource';
import { aiQuestionResource } from './aiQuestions';
import { aiStyleResource } from './aiStyles';
import { postResource } from './blog';
import { categoryResource } from './categories';
import { certificationResource } from './certifications';
import { clientResource } from './clients';
import { disciplineResource } from './disciplines';
import { mediaResource } from './media';
import { navigationResource } from './navigation';
import { pageResource } from './pages';
import { portfolioResource } from './portfolio';
import { redirectResource } from './redirects';
import { sectionResource } from './sections';
import { sectorResource } from './sectors';
import { serviceCaseResource } from './serviceCases';
import { serviceResource } from './services';
import { statisticResource } from './statistics';
import { teamResource } from './team';
import { testimonialResource } from './testimonials';
import { themeResource } from './themes';

// One config per CRUD entity. Everything structural (tenant scoping, authz, audit,
// optimistic locking) lives in resource.ts; these modules are only "which table, which
// columns, which capability, how does the wire shape map to columns".
//
// Admin v2 (W0): one module per entity (resources/<slug>.ts, helpers in ./shared.ts),
// registered here. A new entity is its module, its import, its name below and one line in
// RESOURCES. `@/lib/admin/resources` resolves to this file, so the API routes keep
// importing each config by name.

export {
  aiQuestionResource,
  aiStyleResource,
  categoryResource,
  certificationResource,
  clientResource,
  disciplineResource,
  mediaResource,
  navigationResource,
  pageResource,
  portfolioResource,
  postResource,
  redirectResource,
  sectionResource,
  sectorResource,
  serviceCaseResource,
  serviceResource,
  statisticResource,
  teamResource,
  testimonialResource,
  themeResource,
};

/**
 * Every resource by its admin slug: the segment of /admin/<slug> and /api/admin/<slug>, and
 * its editor's key in RESOURCE_UI (src/lib/admin/ui). Sorted by slug.
 */
export const RESOURCES: Readonly<Record<string, ResourceConfig>> = {
  'ai-questions': aiQuestionResource,
  'ai-styles': aiStyleResource,
  blog: postResource,
  categories: categoryResource,
  certifications: certificationResource,
  clients: clientResource,
  disciplines: disciplineResource,
  media: mediaResource,
  navigation: navigationResource,
  pages: pageResource,
  portfolio: portfolioResource,
  redirects: redirectResource,
  sections: sectionResource,
  sectors: sectorResource,
  'service-cases': serviceCaseResource,
  services: serviceResource,
  statistics: statisticResource,
  team: teamResource,
  testimonials: testimonialResource,
  themes: themeResource,
};
