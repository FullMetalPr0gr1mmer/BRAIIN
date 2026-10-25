import { describe, expect, it } from 'vitest';
import { ROLES, type AuthContext, type Role } from '@/lib/auth/types';
import { ROLE_CAPS } from '@/lib/authz/matrix';
import { visibleNav } from '@/lib/admin/nav';
import { RESOURCES } from '@/lib/admin/resources';
import { uiFor, type FieldDef } from '@/lib/admin/uiSchema';
import { collectionScreen } from '@/lib/admin/collectionScreen';
import {
  clip,
  COLLECTIONS,
  copySlug,
  DELETE_WORDS,
  deleteOutcome,
  deleteQuestion,
  textOf,
} from '@/components/admin/screens/collection/collections';
import { copyPayload } from '@/components/admin/screens/collection/copy';
import { drawerFields, SAMPLE_LOCKED } from '@/components/admin/screens/collection/fields';

// The collection screens (Admin v2 U7: the FAQ, then testimonials, clients, team, numbers
// and certifications on one island, AdminCollection). Pure parts only; the island itself is
// driven end to end in tests/admin/faq.e2e.ts and tests/admin/collections.e2e.ts.

const SLUGS = ['certifications', 'clients', 'faq', 'statistics', 'team', 'testimonials'];

const session = (role: Role): AuthContext => ({
  userId: '11111111-1111-4111-8111-111111111111',
  tenantId: '00000000-0000-0000-0000-0000000000b1',
  role,
  isActive: true,
  email: 'person@example.test',
});

const ID = '5eedfa00-0000-4000-8000-000000000001';

describe('the collections', () => {
  it('are exactly the six, each its own resource and form', () => {
    expect(Object.keys(COLLECTIONS).sort()).toEqual(SLUGS);
    for (const slug of SLUGS) {
      expect(COLLECTIONS[slug]?.slug).toBe(slug);
      expect(RESOURCES[slug], slug).toBeDefined();
      expect(uiFor(slug).slug).toBe(slug);
    }
  });

  it('each page is titled as the menu names it', () => {
    const links = visibleNav('admin').flatMap((group) => group.links);
    for (const slug of SLUGS) {
      const link = links.find((l) => l.href === `/admin/${slug}`);
      expect(link?.label, slug).toBe(COLLECTIONS[slug]?.title);
    }
  });

  it('a list reads only what its projection holds (every key a row shows is listed)', () => {
    // Each definition is run over a row that records the keys it is asked for: a key the
    // list endpoint never returns would make every row read "Needs consent" or "Text only".
    for (const slug of SLUGS) {
      const def = COLLECTIONS[slug]!;
      const read = new Set<string>();
      const row = new Proxy({} as Record<string, unknown>, {
        get: (_target, key) => {
          if (typeof key === 'string') read.add(key);
          return undefined;
        },
      });
      def.rowTitle(row);
      def.rowSub(row);
      def.badges(row);
      def.copy?.(row);
      const listed = new Set(RESOURCES[slug]!.listColumns.split(','));
      expect(
        [...read].filter((key) => !listed.has(key)),
        slug,
      ).toEqual([]);
    }
  });
});

describe('the rows: words and badges', () => {
  it('the FAQ: the question, the answer’s first 80 characters, the status unless Published', () => {
    const def = COLLECTIONS['faq']!;
    const row = {
      question: { en: 'What is it?', ar: 'ما هو؟' },
      answer: { en: 'a'.repeat(100), ar: 'ب' },
      status: 'draft',
    };
    expect(def.rowTitle(row)).toBe('What is it?');
    expect(def.rowSub(row)).toBe(`${'a'.repeat(80)}…`);
    expect(def.badges(row)).toEqual([{ label: '', status: 'draft' }]);
    expect(def.badges({ ...row, status: 'published' })).toEqual([]);
    expect(def.rowTitle({ question: { en: '', ar: 'ما هو؟' } })).toBe('ما هو؟');
  });

  it('testimonials: a sample says Sample; a real quote without consent says Needs consent', () => {
    const def = COLLECTIONS['testimonials']!;
    const labels = (row: object) => def.badges(row as Record<string, unknown>).map((b) => b.label);
    expect(labels({ is_placeholder: true, status: 'published' })).toEqual(['Sample']);
    expect(labels({ is_placeholder: false, status: 'draft' })).toEqual(['Needs consent', '']);
    expect(labels({ consent_obtained_at: '2026-01-01T00:00:00Z', status: 'published' })).toEqual(
      [],
    );
    expect(
      def.rowTitle({
        author_name: { en: 'Sara', ar: 'سارة' },
        quote: { en: 'Great work.', ar: '' },
      }),
    ).toBe('Sara · Great work.');
  });

  it('clients: hidden until cleared to name, logo or text only, in the marquee', () => {
    const def = COLLECTIONS['clients']!;
    expect(def.badges({ visible: false }).map((b) => b.label)).toEqual(['Not cleared to name']);
    expect(def.badges({ visible: true })).toEqual([]);
    expect(def.rowSub({ logo_media_id: ID, show_in_marquee: true })).toBe('Logo · In the marquee');
    expect(def.rowSub({ logo_media_id: null, show_in_marquee: false })).toBe('Text only');
  });

  it('numbers name their pages; certifications their issuer and year', () => {
    expect(COLLECTIONS['statistics']!.rowSub({ placements: ['home', 'work'] })).toBe(
      'Home · Our Work',
    );
    expect(COLLECTIONS['statistics']!.rowSub({ placements: [] })).toBe('Not shown on any page');
    expect(
      COLLECTIONS['certifications']!.rowSub({ issuer: { en: 'ISO', ar: 'أيزو' }, year: 2024 }),
    ).toBe('ISO, 2024');
  });

  it('helpers: English first, a clip cut at a character, a delete question in a bidi isolate', () => {
    expect(textOf({ en: ' A ', ar: 'ب' })).toBe('A');
    expect(textOf({ en: '', ar: 'ب' })).toBe('ب');
    expect(textOf(null)).toBe('');
    expect(clip('😀😀😀', 2)).toBe('😀😀…');
    expect(clip('short', 80)).toBe('short');
    expect(deleteQuestion(COLLECTIONS['faq']!, 'سؤال')).toBe(
      'Delete the question “⁨سؤال⁩”? This cannot be undone.',
    );
  });

  // The three answers a DELETE gives (pinned in tests/lib/stagedKernel.spec.ts): releases off,
  // a staged removal of a live row, and a pending new item thrown away (Admin v2 R12 review).
  it('a Delete says what happened: deleted, a removal waiting for the publish, or thrown away', () => {
    const id = '33333333-3333-4333-8333-333333333301';
    expect(deleteOutcome({ deleted: id })).toBe('deleted');
    expect(deleteOutcome({ deleted: id, pendingRemoval: true, draft: { id, op: 'delete' } })).toBe(
      'removal',
    );
    // A pending new item was never on the site: nothing was staged, so no "removal" words.
    const discarded = deleteOutcome({ deleted: id, draft: null });
    expect(discarded).toBe('discarded');
    expect(DELETE_WORDS[discarded]).not.toMatch(/removal|comes off the site/i);
    expect(DELETE_WORDS.removal).toContain('when it is published');
    expect(Object.values(DELETE_WORDS).join(' ')).not.toMatch(/[–—]/);
  });
});

describe('Duplicate', () => {
  const ui = (slug: string) => uiFor(slug);

  it('a quote: a draft with its own slug, its consent cleared, never a sample', () => {
    const original = {
      id: ID,
      slug: 'quote-home',
      quote: { en: 'Great.', ar: 'رائع.' },
      author_name: { en: 'Sara', ar: 'سارة' },
      consent_obtained_at: '2026-01-01T09:00:00.000Z',
      consent_reference: 'email 12',
      is_placeholder: false,
      status: 'published',
      scheduled_for: '2027-01-01T09:00:00.000Z',
      sort_order: 30,
    };
    const payload = copyPayload(
      COLLECTIONS['testimonials']!,
      ui('testimonials'),
      original,
      new Set(['quote-home']),
    );
    expect(payload).toMatchObject({
      slug: 'quote-home-copy',
      quote: { en: 'Great.', ar: 'رائع.' },
      consentObtainedAt: null,
      consentReference: null,
      isPlaceholder: false,
      status: 'draft',
      sortOrder: 30,
    });
    expect(payload).not.toHaveProperty('scheduledFor');
  });

  it('a design sample, and any team member, is not copied at all', () => {
    expect(
      copyPayload(
        COLLECTIONS['testimonials']!,
        ui('testimonials'),
        { is_placeholder: true },
        new Set(),
      ),
    ).toBeNull();
    expect(
      copyPayload(COLLECTIONS['clients']!, ui('clients'), { is_placeholder: true }, new Set()),
    ).toBeNull();
    expect(
      copyPayload(
        COLLECTIONS['statistics']!,
        ui('statistics'),
        { is_placeholder: true },
        new Set(),
      ),
    ).toBeNull();
    expect(copyPayload(COLLECTIONS['team']!, ui('team'), { slug: 'sara' }, new Set())).toBeNull();
  });

  it('a client copy is hidden until someone clears it, and carries no status (clients have none)', () => {
    const payload = copyPayload(
      COLLECTIONS['clients']!,
      ui('clients'),
      {
        slug: 'neom',
        name: { en: 'Neom', ar: 'نيوم' },
        visible: true,
        show_in_marquee: true,
        sort_order: 10,
      },
      new Set(['neom', 'neom-copy']),
    );
    expect(payload).toMatchObject({ slug: 'neom-copy-2', visible: false, showInMarquee: true });
    expect(payload).not.toHaveProperty('status');
  });

  it('a question: a draft copy with the same words, no slug to suffix', () => {
    const payload = copyPayload(
      COLLECTIONS['faq']!,
      ui('faq'),
      {
        question: { en: 'Q?', ar: 'س؟' },
        answer: { en: 'A.', ar: 'ج.' },
        status: 'published',
        sort_order: 20,
      },
      new Set(),
    );
    expect(payload).toEqual({
      question: { en: 'Q?', ar: 'س؟' },
      answer: { en: 'A.', ar: 'ج.' },
      status: 'draft',
      sortOrder: 20,
    });
  });

  it('copySlug: -copy, then -copy-2…, never past the slug columns’ 64 characters', () => {
    expect(copySlug('a', new Set())).toBe('a-copy');
    expect(copySlug('a-copy', new Set(['a-copy']))).toBe('a-copy-2');
    expect(copySlug('a', new Set(['a-copy', 'a-copy-2']))).toBe('a-copy-3');
    const long = copySlug('x'.repeat(64), new Set());
    expect(long).toHaveLength(64);
    expect(long.endsWith('-copy')).toBe(true);
  });
});

describe('the drawer’s fields', () => {
  const statusOptions = (fields: readonly FieldDef[]) =>
    fields.find((f) => f.name === 'status')?.options?.map((o) => o.value);
  const base = { isNew: false, status: 'draft', sample: 'none' as const };

  it('never the sort order: the list’s drag and arrows are the order', () => {
    const fields = drawerFields(uiFor('faq').fields, {
      ...base,
      permissions: { write: true, remove: true },
    });
    expect(fields.map((f) => f.name)).toEqual(['question', 'answer', 'status', 'scheduledFor']);
  });

  it('Archived only for the roles that may archive, or an item already archived', () => {
    const fields = uiFor('faq').fields;
    expect(
      statusOptions(drawerFields(fields, { ...base, permissions: { write: true, remove: true } })),
    ).toContain('archived');
    expect(
      statusOptions(drawerFields(fields, { ...base, permissions: { write: true, remove: false } })),
    ).toEqual(['draft', 'scheduled', 'published']);
    expect(
      statusOptions(
        drawerFields(fields, {
          ...base,
          status: 'archived',
          permissions: { write: true, remove: false },
        }),
      ),
    ).toContain('archived');
  });

  it('a sample quote: its words and attribution are not drawn until it is being made real', () => {
    const fields = uiFor('testimonials').fields;
    const perms = { write: true, remove: false };
    const locked = drawerFields(fields, { ...base, sample: 'locked', permissions: perms }).map(
      (f) => f.name,
    );
    for (const name of SAMPLE_LOCKED) expect(locked).not.toContain(name);
    expect(locked).not.toContain('isPlaceholder');
    expect(locked).toContain('consentObtainedAt');
    const unlocking = drawerFields(fields, {
      ...base,
      sample: 'unlocking',
      permissions: perms,
    }).map((f) => f.name);
    for (const name of SAMPLE_LOCKED) expect(unlocking).toContain(name);
    expect(unlocking).not.toContain('isPlaceholder');
    // A real quote: no Placeholder box either (the flag is the sample flow's alone).
    expect(
      drawerFields(fields, { ...base, sample: 'real', permissions: perms }).map((f) => f.name),
    ).not.toContain('isPlaceholder');
  });

  it('the other collections keep their Placeholder box', () => {
    const fields = drawerFields(uiFor('clients').fields, {
      ...base,
      status: null,
      permissions: { write: true, remove: false },
    });
    expect(fields.map((f) => f.name)).toContain('isPlaceholder');
  });
});

describe('the page, decided on the server (collectionScreen)', () => {
  const full = (role: Role, cap: keyof (typeof ROLE_CAPS)['admin']) =>
    ROLE_CAPS[role][cap] === 'full';

  it('what each role may do is its capabilities: write in full, delete Admin only', () => {
    for (const slug of SLUGS) {
      const config = RESOURCES[slug]!;
      for (const role of ROLES) {
        const screen = collectionScreen(session(role), slug);
        expect(screen.permissions, `${role} ${slug}`).toEqual({
          write: full(role, config.writeCap),
          remove: full(role, config.deleteCap ?? 'content.archiveDelete'),
        });
      }
    }
    expect(collectionScreen(session('content_creator'), 'faq').permissions).toEqual({
      write: true,
      remove: false,
    });
    expect(collectionScreen(session('seo'), 'faq').permissions).toEqual({
      write: false,
      remove: false,
    });
    expect(collectionScreen(null, 'faq').permissions).toEqual({ write: false, remove: false });
  });

  it('opens the drawer the address names; "new" only for a writer; a non-id is a 404', () => {
    expect(collectionScreen(session('admin'), 'faq', 'new').open).toBe('new');
    expect(collectionScreen(session('seo'), 'faq', 'new').open).toBeNull();
    expect(collectionScreen(session('admin'), 'faq', ID)).toMatchObject({
      open: ID,
      notFound: false,
    });
    expect(collectionScreen(session('admin'), 'faq', 'nope')).toMatchObject({
      open: null,
      notFound: true,
    });
    expect(collectionScreen(session('admin'), 'faq', '')).toMatchObject({
      open: null,
      notFound: true,
    });
  });

  it('titles and lines are the definitions’ (the prototype’s words for the FAQ)', () => {
    const screen = collectionScreen(session('admin'), 'faq');
    expect([screen.title, screen.sub]).toEqual(['FAQ', 'Questions on the Contact page.']);
    expect(() => collectionScreen(session('admin'), 'nope')).toThrow();
  });
});
