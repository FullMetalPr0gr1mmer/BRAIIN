import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import VisibilityList, { windowText } from '@/components/admin/screens/visibility/VisibilityList';
import VisibilityDrawer, { draftOf } from '@/components/admin/screens/visibility/VisibilityDrawer';
import type { VisibilityItem } from '@/components/admin/screens/visibility/types';
import { HOME_REFUSAL, MODE_COPY, TEMPLATE_NOTE } from '@/lib/admin/visibilityCopy';

// The /admin/visibility screen's markup (Admin v2 U14a), rendered on the server as the
// island's first paint would be: real radios in a fieldset with its legend (never clickable
// divs), every field labelled, no style= attribute, the state always in words, and the copy
// rules (P-12: no em or en dash, no brand).

// The list prints days without their year in the current year: the clock is pinned.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-16T09:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

const HOME = '00000000-0000-4000-8000-00000000a001';
const ABOUT = '00000000-0000-4000-8000-00000000a002';

const page = (slug: 'home' | 'about', id: string, setting: VisibilityItem['setting'] = null) =>
  ({
    kind: 'page',
    id,
    slug,
    title: { en: slug === 'home' ? 'Home' : 'About' },
    path: slug === 'home' ? '/' : '/about',
    setting,
  }) as VisibilityItem;

const template: VisibilityItem = {
  kind: 'template',
  template: 'service',
  title: 'Service page',
  path: '/services/…',
  count: 28,
  setting: {
    id: 'row-t',
    mode: 'hidden',
    redirectPageId: null,
    hideFrom: null,
    showOn: null,
    version: 1,
    updatedAt: null,
  },
};

const hiddenAbout = page('about', ABOUT, {
  id: 'row-a',
  mode: 'hidden',
  redirectPageId: HOME,
  hideFrom: '2026-11-01',
  showOn: '2026-11-08',
  version: 2,
  updatedAt: null,
});

const choices = [
  { id: HOME, label: 'Home' },
  { id: ABOUT, label: 'About' },
];

const drawer = (item: VisibilityItem) =>
  renderToStaticMarkup(
    createElement(VisibilityDrawer, {
      item,
      choices,
      busy: false,
      error: null,
      onClose: () => undefined,
      onApply: () => undefined,
    }),
  );

describe('the list', () => {
  const html = renderToStaticMarkup(
    createElement(VisibilityList, {
      items: [page('home', HOME), hiddenAbout, template],
      onOpen: () => undefined,
    }),
  );

  it('says each state in words, with the window and the template’s count', () => {
    expect(html).toContain('>Visible<');
    expect(html).toContain('>Hidden<');
    expect(html).toContain('Always visible');
    expect(html).toContain('1 Nov to 8 Nov');
    expect(html).toContain('Template for 28 services');
  });

  it('one button per row, named for its page, its visible word first', () => {
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Change who can see About"');
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('reads a window as the admin does', () => {
    expect(windowText(null, '2026-11-08')).toBe('until 8 Nov');
    expect(windowText('2026-11-01', null)).toBe('from 1 Nov');
    expect(windowText(null, null)).toBeNull();
  });
});

describe('the drawer', () => {
  it('a page: three real radios in a fieldset with a legend, the hidden extras labelled', () => {
    const html = drawer(hiddenAbout);
    expect(html).toContain('<fieldset class="vis-opts">');
    expect(html).toMatch(/<legend class="visually-hidden">Who can see About<\/legend>/);
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).not.toContain('Behind a password');
    for (const label of [
      'Send visitors of the old link to',
      'Hide from (optional)',
      'Show again on (optional)',
    ]) {
      const id = new RegExp(
        `<label class="vis-label" for="([^"]+)">${label.replace(/[()]/g, '\\$&')}</label>`,
      ).exec(html)?.[1];
      expect(id, label).toBeTruthy();
      expect(html).toContain(`id="${id}"`);
    }
    // The page itself is not a choice; the homepage is first, by its role.
    expect(html).toContain('>The homepage</option>');
    expect(html).not.toContain(`value="${ABOUT}"`);
    expect(html).toContain('A “page not found” screen');
    expect(html).toContain('Applies to the live site within a minute.');
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('the homepage: the other modes are disabled and the refusal is said', () => {
    const html = drawer(page('home', HOME));
    expect(html).toContain(HOME_REFUSAL);
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });

  it('a template: public or hidden only, and its note', () => {
    const html = drawer(template);
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).not.toContain(MODE_COPY.link.title);
    expect(html).toContain(TEMPLATE_NOTE.service);
  });

  it('a first hide sends visitors home; a hidden page keeps its own redirect, or the 404', () => {
    expect(draftOf(page('about', ABOUT), HOME)).toEqual({
      mode: 'public',
      redirect: HOME,
      hideFrom: '',
      showOn: '',
    });
    expect(draftOf(hiddenAbout, HOME).redirect).toBe(HOME);
    expect(draftOf(template, HOME).redirect).toBe('');
  });
});

describe('the copy keeps the client’s rules (P-12)', () => {
  it('no em or en dash, no brand', () => {
    const texts = [
      HOME_REFUSAL,
      ...Object.values(MODE_COPY).flatMap((c) => [c.title, c.text, c.badge]),
      ...Object.values(TEMPLATE_NOTE),
    ];
    for (const text of texts) {
      expect(text).not.toMatch(/[–—]/);
      expect(text.toLowerCase()).not.toMatch(/braii?n|statii?on/);
    }
  });
});
