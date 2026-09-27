import { describe, it, expect } from 'vitest';
import {
  CaseProblemSchema,
  CaseResultSchema,
  DeliverableSchema,
  DisciplineRowSchema,
  ResultCardSchema,
  ServiceCaseRowSchema,
  ServiceDetailRowSchema,
  ServiceRowSchema,
  STAT_PLACEMENTS,
  ValuePointSchema,
} from '@schemas/content';
import {
  DisciplineUpdateSchema,
  DisciplineWriteSchema,
  ServiceCaseUpdateSchema,
  ServiceCaseWriteSchema,
  ServiceUpdateSchema,
  ServiceWriteSchema,
  StatisticWriteSchema,
} from '@schemas/admin';

// Round 2 (0028): disciplines, the service-page fields and the service case block. The
// write schemas hold the migration's array ceilings and the EXC-009 clip fence, so an
// editor is told on the field rather than by a raw 23514; the row schemas are what the
// public loaders parse (a malformed row is dropped and logged, never half-rendered).

const t = (en: string) => ({ en, ar: `ع-${en}` });
const UUID = '11111111-1111-4111-8111-111111111111';
const many = <T>(n: number, item: T): T[] => Array.from({ length: n }, () => item);
const point = { title: t('Tested at real sizes'), text: t('Checked as a 16 pixel icon.') };

describe('item shapes', () => {
  it('a value point is a bilingual title AND text', () => {
    expect(ValuePointSchema.safeParse(point).success).toBe(true);
    expect(ValuePointSchema.safeParse({ title: point.title }).success).toBe(false);
    expect(ValuePointSchema.safeParse({ ...point, title: { en: 'EN only' } }).success).toBe(false);
    expect(ValuePointSchema.safeParse({ ...point, title: t('x'.repeat(121)) }).success).toBe(false);
  });

  it('a deliverable is one bilingual line', () => {
    expect(DeliverableSchema.safeParse(t('One page usage sheet')).success).toBe(true);
    expect(DeliverableSchema.safeParse({ en: 'x', ar: '  ' }).success).toBe(false);
  });

  it('a case problem pairs the problem with what we did', () => {
    expect(CaseProblemSchema.safeParse({ problem: t('p'), solution: t('s') }).success).toBe(true);
    // the mockup's own keys are translated by the seed, never accepted as they are
    expect(CaseProblemSchema.safeParse({ p: t('p'), s: t('s') }).success).toBe(false);
  });

  it("a case result IS the case study's result card (one shape, 0022)", () => {
    expect(CaseResultSchema).toBe(ResultCardSchema);
    expect(CaseResultSchema.safeParse({ value: '+27%', label: t('parent recall') }).success).toBe(
      true,
    );
  });
});

describe('row schemas', () => {
  const svc = {
    id: UUID,
    slug: 'logo',
    title: t('Logo Design'),
    short_title: null,
    blurb: t('A mark that works on a sign, a favicon, and a stamp.'),
    body_html: null,
    hero_video_uid: null,
    category: null,
    is_teaser: false,
    sort_order: 10,
    updated_at: null,
    discipline_id: UUID,
    intro: t('A logo is a promise you repeat thousands of times.'),
    value_points: many(3, point),
    deliverables: many(5, t('d')),
    preview_video_path: '/media/showreel.mp4',
    preview_start_s: 5.9,
    preview_end_s: 6.9,
    poster: null,
  };

  it('a service with its page fields parses; the database ceilings hold', () => {
    expect(ServiceRowSchema.safeParse(svc).success).toBe(true);
    expect(ServiceRowSchema.safeParse({ ...svc, value_points: many(7, point) }).success).toBe(
      false,
    );
    expect(ServiceRowSchema.safeParse({ ...svc, deliverables: many(13, t('d')) }).success).toBe(
      false,
    );
    expect(ServiceRowSchema.safeParse({ ...svc, intro: { en: 'EN only' } }).success).toBe(false);
  });

  it('the detail row adds the Tiptap source (malformed → null, the row survives)', () => {
    const detail = ServiceDetailRowSchema.safeParse({ ...svc, body: 'nope', discipline: null });
    expect(detail.success && detail.data.body).toBeNull();
    const withDiscipline = ServiceDetailRowSchema.safeParse({
      ...svc,
      body: null,
      discipline: { slug: 'branding', name: t('Branding'), sort_order: 10 },
    });
    expect(withDiscipline.success).toBe(true);
  });

  it('a discipline needs a bilingual name; short and blurb may be null', () => {
    const d = {
      id: UUID,
      slug: 'branding',
      name: t('Branding'),
      short: null,
      blurb: null,
      sort_order: 10,
      updated_at: null,
      preview_video_path: null,
      preview_start_s: null,
      preview_end_s: null,
      poster: null,
    };
    expect(DisciplineRowSchema.safeParse(d).success).toBe(true);
    expect(DisciplineRowSchema.safeParse({ ...d, name: { en: 'Branding' } }).success).toBe(false);
    expect(DisciplineRowSchema.safeParse({ ...d, slug: 'Branding' }).success).toBe(false);
  });

  it('a case row: bounded problems and results, the project optional', () => {
    const problem = { problem: t('p'), solution: t('s') };
    const result = { value: '4', label: t('campuses under one mark') };
    const c = {
      id: UUID,
      service_id: UUID,
      portfolio_id: null,
      title: t('A school group rebrand'),
      context: null,
      problems: many(3, problem),
      results: many(3, result),
      updated_at: null,
      project: null,
    };
    expect(ServiceCaseRowSchema.safeParse(c).success).toBe(true);
    expect(ServiceCaseRowSchema.safeParse({ ...c, problems: many(7, problem) }).success).toBe(
      false,
    );
    expect(ServiceCaseRowSchema.safeParse({ ...c, results: many(5, result) }).success).toBe(false);
  });
});

describe('admin writes', () => {
  const clip = { path: '/media/showreel.mp4', startS: 5.9, endS: 6.9 };
  const base = { slug: 'logo', title: t('Logo Design') };

  it('a service takes its discipline, intro, value points, deliverables, poster and clip', () => {
    const ok = ServiceWriteSchema.safeParse({
      ...base,
      disciplineId: UUID,
      intro: t('A logo is a promise.'),
      valuePoints: many(3, point),
      deliverables: many(5, t('d')),
      posterMediaId: UUID,
      clip,
    });
    expect(ok.success).toBe(true);
    // Arrays default to empty on create (the column default) and stay absent on a PATCH.
    const bare = ServiceWriteSchema.parse(base);
    expect(bare.valuePoints).toEqual([]);
    expect(bare.deliverables).toEqual([]);
    const patch = ServiceUpdateSchema.parse({ version: 1, title: t('Logo') });
    expect('valuePoints' in patch).toBe(false);
  });

  it('holds the 0028 ceilings (6 value points, 12 deliverables)', () => {
    expect(ServiceWriteSchema.safeParse({ ...base, valuePoints: many(7, point) }).success).toBe(
      false,
    );
    expect(ServiceWriteSchema.safeParse({ ...base, deliverables: many(13, t('d')) }).success).toBe(
      false,
    );
  });

  it('a clip is a site file until Stream — the columns cannot hold a Stream uid', () => {
    const uid = { streamUid: 'a'.repeat(32) };
    expect(ServiceWriteSchema.safeParse({ ...base, clip: uid }).success).toBe(false);
    const offsite = { path: 'https://evil.example/x.mp4' };
    expect(ServiceWriteSchema.safeParse({ ...base, clip: offsite }).success).toBe(false);
    expect(ServiceWriteSchema.safeParse({ ...base, clip: { ...clip, endS: 40 } }).success).toBe(
      false,
    );
    expect(ServiceWriteSchema.safeParse({ ...base, clip: null }).success).toBe(true);
  });

  it('a discipline: 64-character slug (the 0028 CHECK), bilingual name, the clip fence', () => {
    const d = { slug: 'branding', name: t('Branding') };
    expect(DisciplineWriteSchema.safeParse({ ...d, clip, posterMediaId: UUID }).success).toBe(true);
    expect(DisciplineWriteSchema.safeParse({ ...d, slug: 'a'.repeat(65) }).success).toBe(false);
    expect(DisciplineWriteSchema.safeParse({ ...d, name: { en: 'Branding' } }).success).toBe(false);
    const uid = { streamUid: 'a'.repeat(32) };
    expect(DisciplineWriteSchema.safeParse({ ...d, clip: uid }).success).toBe(false);
    expect(DisciplineUpdateSchema.safeParse({ short: t('x') }).success).toBe(false); // no version
    expect(DisciplineUpdateSchema.safeParse({ short: t('x'), version: 1 }).success).toBe(true);
  });

  it('a service case: its service is required; problems and results bounded', () => {
    const c = { serviceId: UUID, title: t('A school group rebrand') };
    expect(ServiceCaseWriteSchema.safeParse(c).success).toBe(true);
    expect(ServiceCaseWriteSchema.safeParse({ title: c.title }).success).toBe(false);
    const problems = many(7, { problem: t('p'), solution: t('s') });
    expect(ServiceCaseWriteSchema.safeParse({ ...c, problems }).success).toBe(false);
    const results = many(5, { value: '1', label: t('x') });
    expect(ServiceCaseWriteSchema.safeParse({ ...c, results }).success).toBe(false);
    expect(ServiceCaseUpdateSchema.safeParse({ isPlaceholder: false, version: 3 }).success).toBe(
      true,
    );
  });
});

describe('statistics gain a Services-page placement (0028)', () => {
  it('the table placements include services; a per-page services label is accepted', () => {
    expect(STAT_PLACEMENTS).toContain('services');
    const ok = StatisticWriteSchema.safeParse({
      slug: 'client-satisfaction',
      label: t('Client satisfaction across every project'),
      valueNumeric: 98,
      valueSuffix: '%',
      placements: ['services'],
      placementLabels: { services: t('Client satisfaction') },
    });
    expect(ok.success).toBe(true);
  });
});
