import { describe, it, expect, vi } from 'vitest';
import type { TeamMemberRow } from '@schemas/content';
import {
  AboutWhoSectionContentSchema,
  LeadershipSectionContentSchema,
  SocialSectionContentSchema,
  sectionContentIssues,
} from '@schemas/sections';
import { keyStep, pad2, sliderState } from '@/lib/client/slider';
import { DEFAULT_ABOUT_SECTIONS, type SectionData } from '@/lib/sections/types';

// UI v2 PR8 (About): the pure halves — content schemas, the slider geometry, the route's
// section plumbing and Person JSON-LD, and the leadership row mapping. The DOM halves are
// tests/e2e/about-page.e2e.ts.

vi.mock('@/lib/media/static', () => ({
  staticImage: (key: string) =>
    key === 'stills/work/p2.jpg' ? { src: '/_astro/p2.jpg', width: 1280, height: 720 } : null,
}));

const { toLeader } = await import('@/lib/data/team');
const { leadershipJsonLd, showsSection, withLeaders } = await import('@/lib/sections/about');

const t = (en: string, ar = `ع ${en}`) => ({ en, ar });

describe('aboutWho content', () => {
  const heading = (en: string, ar = en) =>
    AboutWhoSectionContentSchema.safeParse({ heading: { en, ar } });

  it('accepts the design heading in both languages (14 and 11 words)', () => {
    expect(
      heading(
        'Born in Jeddah. Built to move ideas from the brain into the real world.',
        'وُلدنا في جدة. وُجدنا لننقل الأفكار من الدماغ إلى أرض الواقع.',
      ).success,
    ).toBe(true);
  });

  it('bounds the heading to the 16-rung entrance ladder, 24 characters per word', () => {
    expect(heading(Array.from({ length: 16 }, () => 'word').join(' ')).success).toBe(true);
    expect(heading(Array.from({ length: 17 }, () => 'word').join(' ')).success).toBe(false);
    expect(heading('a'.repeat(24)).success).toBe(true);
    expect(heading('a'.repeat(25)).success).toBe(false);
    // each locale on its own
    expect(heading('short', Array.from({ length: 17 }, () => 'كلمة').join(' ')).success).toBe(
      false,
    );
    expect(heading('   ').success).toBe(false);
  });

  it('takes a poster by media id and a clip window — nothing else (strict)', () => {
    expect(
      sectionContentIssues('aboutWho', {
        mediaId: '5eed0a00-0000-4000-8000-000000000003',
        clip: { path: '/media/showreel.mp4', startS: 6.2, endS: 7.9 },
      }),
    ).toEqual([]);
    expect(sectionContentIssues('aboutWho', { mediaId: 'stills/work/p2.jpg' }).length).toBe(1);
    expect(sectionContentIssues('aboutWho', { posterUrl: 'https://x/p.jpg' }).length).toBe(1);
    // the EXC-009 fence: a /media/*.mp4 path only
    expect(
      sectionContentIssues('aboutWho', { clip: { path: 'https://evil.example/v.mp4' } }).length,
    ).toBeGreaterThan(0);
  });

  it('caps the manifesto at 6 paragraphs, each bilingual', () => {
    const p = { title: t('Title.'), body: t('Body') };
    expect(AboutWhoSectionContentSchema.safeParse({ paragraphs: Array(6).fill(p) }).success).toBe(
      true,
    );
    expect(AboutWhoSectionContentSchema.safeParse({ paragraphs: Array(7).fill(p) }).success).toBe(
      false,
    );
    expect(
      AboutWhoSectionContentSchema.safeParse({ paragraphs: [{ title: { en: 'x' }, body: t('b') }] })
        .success,
    ).toBe(false);
  });
});

describe('leadership and social content', () => {
  it('leadership takes copy only — the people come from team_members', () => {
    expect(LeadershipSectionContentSchema.safeParse({ heading: t('Meet us') }).success).toBe(true);
    expect(sectionContentIssues('leadership', { leaders: [] }).length).toBe(1);
    expect(sectionContentIssues('leadership', { members: [] }).length).toBe(1);
  });

  it('social has the paper and klein layouts, and a text line', () => {
    expect(SocialSectionContentSchema.safeParse({ variant: 'klein', text: t('x') }).success).toBe(
      true,
    );
    expect(SocialSectionContentSchema.safeParse({ variant: 'dark' }).success).toBe(false);
  });
});

describe('the default About composition follows the mockup', () => {
  it('who we are → leadership → our reach → follow (Klein)', () => {
    expect(DEFAULT_ABOUT_SECTIONS.map((s) => s.type)).toEqual([
      'aboutWho',
      'leadership',
      'statistics',
      'social',
    ]);
    expect(DEFAULT_ABOUT_SECTIONS[2]!.props).toEqual({ variant: 'reach', placement: 'about' });
    expect(DEFAULT_ABOUT_SECTIONS[3]!.props).toEqual({ variant: 'klein' });
  });

  it('carries no media in code (the poster is seeded content, never a code fallback)', () => {
    expect(DEFAULT_ABOUT_SECTIONS[0]!.props).toBeUndefined();
  });
});

describe('slider geometry', () => {
  // 6 cards of 300px + 20px gap in a 1260px track: 4 per view, 640px of overflow.
  const g = (pos: number, over: Partial<Parameters<typeof sliderState>[0]> = {}) =>
    sliderState({ pos, scrollWidth: 1900, clientWidth: 1260, step: 320, count: 6, ...over });

  it('at rest: 4 in view, "01 / 06", previous disabled, bar a quarter-ish from 0', () => {
    const s = g(0);
    expect(s).toMatchObject({ overflow: true, atStart: true, atEnd: false, first: 0, perView: 4 });
    expect([s.current, s.total]).toEqual(['01', '06']);
    expect(s.barOffset).toBe(0);
    expect(s.barScale).toBeCloseTo(4 / 6);
  });

  it('one step in: "02 / 06", both directions enabled', () => {
    const s = g(320);
    expect(s).toMatchObject({ atStart: false, atEnd: false, first: 1, current: '02' });
    expect(s.barOffset).toBeCloseTo(1 / 6);
  });

  it('at the end: next disabled, first visible never past count − perView', () => {
    const s = g(640);
    expect(s).toMatchObject({ atEnd: true, first: 2, current: '03' });
    expect(g(9999).first).toBe(2); // an over-reported position is clamped
  });

  it('no overflow: the chrome stays hidden', () => {
    const s = g(0, { scrollWidth: 1260, count: 4 });
    expect(s.overflow).toBe(false);
    expect(s.barScale).toBe(1);
  });

  it('never divides by zero (no cards, no width yet)', () => {
    const s = sliderState({ pos: 0, scrollWidth: 0, clientWidth: 0, step: 0, count: 0 });
    expect(s).toMatchObject({ overflow: false, first: 0, perView: 0, current: '00', total: '00' });
    expect(Number.isFinite(s.barScale)).toBe(true);
  });

  it('arrow keys follow the reading direction', () => {
    expect(keyStep('ArrowRight', false)).toBe(1);
    expect(keyStep('ArrowLeft', false)).toBe(-1);
    expect(keyStep('ArrowRight', true)).toBe(-1);
    expect(keyStep('ArrowLeft', true)).toBe(1);
    expect(keyStep('Enter', false)).toBe(0);
  });

  it('pads the counter to two digits', () => {
    expect([pad2(1), pad2(6), pad2(12)]).toEqual(['01', '06', '12']);
  });
});

const row = (over: Partial<TeamMemberRow> = {}): TeamMemberRow => ({
  slug: 'leader-1',
  name: t('Name Surname', 'الاسم الكامل'),
  bio: null,
  avatar_url: null,
  sort_order: 1,
  role: t('Founder & CEO', 'المؤسس والرئيس التنفيذي'),
  linkedin_url: null,
  is_leadership: true,
  portrait: null,
  ...over,
});

describe('leadership rows', () => {
  it('keeps a real LinkedIn profile URL', () => {
    expect(
      toLeader(row({ linkedin_url: 'https://www.linkedin.com/in/jane-doe' })).linkedinUrl,
    ).toBe('https://www.linkedin.com/in/jane-doe');
  });

  it('drops anything else — it renders into an <a href>', () => {
    for (const url of [
      'javascript:alert(1)',
      'http://linkedin.com/in/x',
      'https://linkedin.com.evil.example/in/x',
      'https://evil.example/?u=linkedin.com/in/x',
      '',
    ]) {
      expect(toLeader(row({ linkedin_url: url })).linkedinUrl, url).toBeNull();
    }
  });

  it('resolves a static portrait and ignores an unknown one', () => {
    const portrait = {
      id: '55555555-5555-4555-8555-555555555555',
      kind: 'image',
      provider: 'static' as const,
      storage_path: 'stills/work/p2.jpg',
      width: 10,
      height: 10,
      alt: null,
      stream_uid: null,
    };
    expect(toLeader(row({ portrait })).portrait?.width).toBe(1280);
    expect(
      toLeader(row({ portrait: { ...portrait, storage_path: 'stills/x.jpg' } })).portrait,
    ).toBe(null);
  });
});

describe('About route plumbing', () => {
  const leaders = [
    toLeader(row({ linkedin_url: 'https://linkedin.com/in/a' })),
    toLeader(row({ slug: 'leader-2', role: null })),
  ];
  const org = { name: 'Braiin Statiion' };
  const opts = { locale: 'en' as const, org, siteBase: 'https://www.braiinstation.com' };

  it('injects the leaders as route data, which content cannot replace', () => {
    const sections: SectionData[] = [
      { type: 'aboutWho' },
      { type: 'leadership', props: { heading: t('x') }, data: { other: 1 } },
    ];
    const out = withLeaders(sections, leaders);
    expect(out[0]).toEqual({ type: 'aboutWho' });
    expect(out[1]!.data).toEqual({ other: 1, leaders });
    expect(out[1]!.props).toEqual({ heading: t('x') });
    expect(sections[1]!.data).toEqual({ other: 1 }); // input untouched
  });

  it('a hidden section is not shown', () => {
    expect(showsSection([{ type: 'leadership', visible: false }], 'leadership')).toBe(false);
    expect(showsSection([{ type: 'leadership' }], 'leadership')).toBe(true);
    expect(showsSection([{ type: 'team' }], 'leadership')).toBe(false);
  });

  it('Person JSON-LD names only the leaders the page shows, with jobTitle and sameAs', () => {
    const nodes = leadershipJsonLd([{ type: 'leadership' }], leaders, opts);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      '@type': 'Person',
      name: 'Name Surname',
      jobTitle: 'Founder & CEO',
      sameAs: ['https://linkedin.com/in/a'],
    });
    expect(nodes[1]!.jobTitle).toBeUndefined();
    expect(nodes[1]!.sameAs).toBeUndefined();
    expect(leadershipJsonLd([{ type: 'leadership', visible: false }], leaders, opts)).toEqual([]);
    expect(leadershipJsonLd([{ type: 'aboutWho' }], leaders, opts)).toEqual([]);
  });

  it('localises the Person name and role', () => {
    const [node] = leadershipJsonLd([{ type: 'leadership' }], leaders, { ...opts, locale: 'ar' });
    expect(node).toMatchObject({ name: 'الاسم الكامل', jobTitle: 'المؤسس والرئيس التنفيذي' });
  });

  it('a portrait becomes an absolute image URL', () => {
    const portrait = {
      id: '55555555-5555-4555-8555-555555555555',
      kind: 'image',
      provider: 'static' as const,
      storage_path: 'stills/work/p2.jpg',
      width: 10,
      height: 10,
      alt: null,
      stream_uid: null,
    };
    const [node] = leadershipJsonLd([{ type: 'leadership' }], [toLeader(row({ portrait }))], opts);
    expect(node!.image).toBe('https://www.braiinstation.com/_astro/p2.jpg');
  });
});
