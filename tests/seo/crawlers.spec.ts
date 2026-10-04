import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ServiceRow } from '@schemas/content';
import type { Discipline } from '@/lib/data/disciplines';
import { seedDisciplines, seedServiceRows } from '../fixtures/serviceSeeds';
import { PUBLIC_SITE_URL as SITE } from '../stubs/astro-env-client';

// Services and disciplines default to none (Supabase is unconfigured under test); the
// Round 2 describe below swaps in the seeded catalogue.
let services: ServiceRow[] = [];
let disciplines: Discipline[] = [];
vi.mock('@/lib/data/services', () => ({ getPublishedServices: async () => services }));
vi.mock('@/lib/data/disciplines', () => ({ getPublishedDisciplines: async () => disciplines }));

const { TRAINING_DENY, RETRIEVAL_ALLOW, USER_FETCH_ALLOW } = await import('@/lib/seo/crawlers');
const { GET: robotsGet } = await import('@/pages/robots.txt');
const { GET: llmsGet } = await import('@/pages/llms.txt');
const { llmsServiceLines } = await import('@/lib/services/discovery');

// CLAUDE.md Pillar 3 names the exact token set. Asserting against a literal list here —
// rather than against the arrays themselves — is the point: a test that reads
// TRAINING_DENY and checks TRAINING_DENY passes no matter what the map says.
const REQUIRED_DENY = [
  'GPTBot',
  'ClaudeBot',
  'Google-Extended',
  'CCBot',
  'Applebot-Extended',
  'Meta-ExternalAgent',
];
const REQUIRED_ALLOW = ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot', 'Bingbot'];

// A fresh `locals` per call, as each request gets: the identity memo lives on it.
const call = async (handler: unknown) =>
  await (handler as unknown as (ctx: { locals: object }) => Response | Promise<Response>)({
    locals: {},
  });

describe('AI crawler policy (three tiers)', () => {
  it('every tier is non-empty', () => {
    expect(TRAINING_DENY.length).toBeGreaterThan(0);
    expect(RETRIEVAL_ALLOW.length).toBeGreaterThan(0);
    expect(USER_FETCH_ALLOW.length).toBeGreaterThan(0);
  });

  it('tiers are mutually disjoint (a UA cannot be in two tiers)', () => {
    const all = [...TRAINING_DENY, ...RETRIEVAL_ALLOW, ...USER_FETCH_ALLOW];
    expect(new Set(all).size).toBe(all.length);
  });

  it('denies EVERY training crawler CLAUDE.md names — including Meta-ExternalAgent', () => {
    // Meta-ExternalAgent was previously missing from this assertion while being present
    // in the map: the one token the standard calls out explicitly was the one unguarded.
    for (const ua of REQUIRED_DENY) expect(TRAINING_DENY).toContain(ua);
  });

  it('allows EVERY retrieval crawler CLAUDE.md names — including Bingbot', () => {
    for (const ua of REQUIRED_ALLOW) expect(RETRIEVAL_ALLOW).toContain(ua);
  });
});

// The snapshot test that robots.txt.ts:5 and crawlers.ts:3 both claimed existed. It did
// not — nothing invoked the route, so the map and the emitted file could diverge freely.
describe('/robots.txt is generated from the crawler map', () => {
  it('emits Disallow: / for every training crawler', async () => {
    const body = await (await call(robotsGet)).text();
    for (const ua of REQUIRED_DENY) {
      expect(body).toContain(`User-agent: ${ua}\nDisallow: /\n`);
    }
  });

  it('emits Allow: / for every retrieval and user-fetch crawler', async () => {
    const body = await (await call(robotsGet)).text();
    for (const ua of [...RETRIEVAL_ALLOW, ...USER_FETCH_ALLOW]) {
      expect(body).toContain(`User-agent: ${ua}\nAllow: /`);
    }
  });

  it('never allows a training crawler by accident', async () => {
    const body = await (await call(robotsGet)).text();
    for (const ua of TRAINING_DENY) {
      const block = body.split(`User-agent: ${ua}\n`)[1]?.split('\n\n')[0] ?? '';
      expect(block).toContain('Disallow: /');
      expect(block).not.toContain('Allow: /');
    }
  });

  it('keeps /admin and /api out of the generic crawl', async () => {
    const body = await (await call(robotsGet)).text();
    expect(body).toContain('User-agent: *');
    expect(body).toContain('Disallow: /admin');
    expect(body).toContain('Disallow: /api/');
  });

  it('points at the sitemap and the llms.txt index', async () => {
    const body = await (await call(robotsGet)).text();
    expect(body).toMatch(/Sitemap: https?:\/\/\S+\/sitemap\.xml/);
    expect(body).toContain('/llms.txt');
  });

  it('is served as plain text', async () => {
    expect((await call(robotsGet)).headers.get('content-type')).toContain('text/plain');
  });
});

describe('/llms.txt agrees with the crawler map', () => {
  it('names the same deny and allow tokens rather than restating policy in prose', async () => {
    // llms.txt used to describe the policy in prose while importing nothing from
    // crawlers.ts, so it could contradict robots.txt silently.
    const body = await (await call(llmsGet)).text();
    for (const ua of REQUIRED_DENY) expect(body).toContain(ua);
    for (const ua of REQUIRED_ALLOW) expect(body).toContain(ua);
  });

  it('states no service COUNT — a hardcoded "14 services" drifts from reality', async () => {
    const body = await (await call(llmsGet)).text();
    expect(body).not.toMatch(/\d+\s+services/i);
  });

  it('lists Our Work and All projects (UI v2), still with no counts', async () => {
    const body = await (await call(llmsGet)).text();
    expect(body).toContain(`- Our Work: ${SITE}/portfolio\n`);
    expect(body).toContain(`- All projects: ${SITE}/portfolio/all\n`);
    expect(body).toContain('## Case studies');
    expect(body).not.toMatch(/\d+\s+(projects|case studies)/i);
  });

  it('lists the Join page (careers)', async () => {
    const body = await (await call(llmsGet)).text();
    expect(body).toContain(`- Join (careers): ${SITE}/join\n`);
  });

  it('points at both language roots and defers to robots.txt as authoritative', async () => {
    const body = await (await call(llmsGet)).text();
    expect(body).toContain('/ar/');
    expect(body).toContain('robots.txt');
  });

  it('names the studio and its mailbox from the public identity, never a literal', async () => {
    const body = await (await call(llmsGet)).text();
    expect(body.split('\n')[0]).toBe('# Braiin Statiion (بريّن ستيشن)');
    expect(body).toContain('hello@braiinstatiion.com');
    expect(body).not.toMatch(/Braiin Station\b/);
  });
});

describe('/llms.txt lists the services by discipline (Round 2)', () => {
  afterEach(() => {
    services = [];
    disciplines = [];
  });

  const servicesSection = (body: string) => body.split('## Services\n')[1]?.split('\n## ')[0] ?? '';

  it('one ### heading per discipline, in order, each followed by its services', async () => {
    services = seedServiceRows();
    disciplines = seedDisciplines();
    const section = servicesSection(await (await call(llmsGet)).text());
    const headings = [...section.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      'Branding',
      'Production',
      'Marketing',
      'Website Development',
      'Events & Exhibitions',
    ]);
    expect(section.match(/^- /gm)).toHaveLength(28);
    const branding = section.split('### Branding\n')[1]?.split('\n\n')[0] ?? '';
    expect(branding.split('\n')[0]).toBe(`- Logo Design — ${SITE}/services/logo`);
    expect(branding.split('\n')).toHaveLength(8);
  });

  it('still states no count — in a heading or anywhere else', async () => {
    services = seedServiceRows();
    disciplines = seedDisciplines();
    const body = await (await call(llmsGet)).text();
    expect(body).not.toMatch(/\d+\s+services/i);
    expect(body).not.toMatch(/^### .*\d/m);
  });

  it('never drops a service: ungrouped ones go last, and no disciplines means a flat list', () => {
    const rows = seedServiceRows();
    const loose = { ...rows[0]!, slug: 'loose', discipline_id: null };
    const grouped = llmsServiceLines([...rows, loose], seedDisciplines(), 'https://x');
    expect(grouped.slice(-2)).toEqual([
      '### Other services',
      '- Logo Design — https://x/services/loose',
    ]);
    const flat = llmsServiceLines(rows, [], 'https://x');
    expect(flat).toHaveLength(28);
    expect(flat.some((l) => l.startsWith('###'))).toBe(false);
  });
});
