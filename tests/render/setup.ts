import { vi } from 'vitest';

// The render project's data (vitest.render.config.ts `setupFiles`): the loaders a section
// calls on its own return tests/render/fixtures.ts, so every data-driven band renders and
// the copy around its data is in the output. Everything else in these modules is the real
// code.

vi.mock('@/lib/data/disciplines', async (importOriginal) => {
  const f = await import('./fixtures');
  return {
    ...(await importOriginal<object>()),
    getPublishedDisciplines: async () => f.DISCIPLINES,
  };
});
vi.mock('@/lib/data/portfolio', async (importOriginal) => {
  const f = await import('./fixtures');
  return {
    ...(await importOriginal<object>()),
    getPortfolioCards: async (opts: { featuredOnly?: boolean } = {}) =>
      opts.featuredOnly ? f.CARDS.filter((c) => c.isFeatured) : f.CARDS,
  };
});
vi.mock('@/lib/data/taxonomy', async (importOriginal) => {
  const f = await import('./fixtures');
  return {
    ...(await importOriginal<object>()),
    getMarqueeClients: async () => f.CLIENTS,
    getTestimonials: async (opts: { limit?: number } = {}) =>
      f.TESTIMONIALS.slice(0, opts.limit ?? 8),
  };
});
vi.mock('@/lib/data/statistics', async (importOriginal) => {
  const f = await import('./fixtures');
  return {
    ...(await importOriginal<object>()),
    getPublishedStatistics: async () => f.STATS,
  };
});
vi.mock('@/lib/data/team', async (importOriginal) => {
  const f = await import('./fixtures');
  return {
    ...(await importOriginal<object>()),
    getPublishedTeam: async () => f.TEAM,
    getLeadership: async () => f.LEADERS,
  };
});
vi.mock('@/lib/data/certifications', async (importOriginal) => {
  const f = await import('./fixtures');
  return {
    ...(await importOriginal<object>()),
    getPublishedCertifications: async () => f.CERTIFICATIONS,
  };
});
vi.mock('@/lib/data/sectionMedia', async (importOriginal) => {
  const f = await import('./fixtures');
  return {
    ...(await importOriginal<object>()),
    getSectionImage: async (id: string | undefined) => (id === f.POSTER.id ? f.POSTER : null),
    getSectionImages: async (ids: readonly string[]) =>
      new Map(ids.filter((id) => id === f.POSTER.id).map((id) => [id, f.POSTER])),
  };
});
