import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import VisibilityList, { windowText } from '@/components/admin/screens/visibility/VisibilityList';
import VisibilityDrawer, {
  draftOf,
  draftReady,
} from '@/components/admin/screens/visibility/VisibilityDrawer';
import { edgeLine } from '@/components/admin/screens/visibility/VisibilityScreen';
import type { VisibilityItem } from '@/components/admin/screens/visibility/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APPLIES_WITHIN,
  CONFIRM_SUB,
  HIDDEN_NOTE,
  HOME_REFUSAL,
  MODE_COPY,
  PASSWORD_HINT,
  PASSWORD_NOTE,
  PASSWORD_REQUIRED,
  TEMPLATE_NOTE,
} from '@/lib/admin/visibilityCopy';
import { VISIBILITY_KV_CACHE_TTL_S, VISIBILITY_MEMO_MS } from '@/lib/http/visibility';

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
    note: null,
    passwordVersion: 0,
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
  note: null,
  passwordVersion: 0,
  version: 2,
  updatedAt: null,
});

const passwordAbout = page('about', ABOUT, {
  id: 'row-p',
  mode: 'password',
  redirectPageId: null,
  hideFrom: null,
  showOn: null,
  note: { en: 'Ask the studio for the password.' },
  passwordVersion: 2,
  version: 3,
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
  it('a page: four real radios in a fieldset with a legend, the hidden extras labelled', () => {
    const html = drawer(hiddenAbout);
    expect(html).toContain('<fieldset class="vis-opts">');
    expect(html).toMatch(/<legend class="visually-hidden">Who can see About<\/legend>/);
    expect(html.match(/type="radio"/g)).toHaveLength(4);
    // The fourth is U14b's, offered but not chosen, so none of its fields is rendered.
    expect(html).toContain('Behind a password');
    expect(html).not.toContain('type="password"');
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
    expect(html).toContain('Applies to the live site within a few minutes.');
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('the hidden option names both of its outcomes: the page you choose, or page not found', () => {
    // The select offers a redirect or the 404 (decide(): no target is a 404).
    const html = drawer(hiddenAbout);
    expect(MODE_COPY.hidden.text).toContain('sent to a page you choose');
    expect(MODE_COPY.hidden.text).toContain('or sees a page not found screen');
    expect(html).toContain(MODE_COPY.hidden.text);
  });

  it('hidden says what it does not do: the words stay published, the form stays open', () => {
    const html = drawer(hiddenAbout);
    expect(HIDDEN_NOTE).toContain('Hiding is not deleting');
    expect(HIDDEN_NOTE).toContain('Accepting job applications');
    expect(html).toContain('Hiding is not deleting');
    // Only with the hidden option: a page visible to everyone has nothing to warn about.
    expect(drawer(page('about', ABOUT))).not.toContain('Hiding is not deleting');
  });

  it('the homepage: the other modes are disabled and the refusal is said', () => {
    const html = drawer(page('home', HOME));
    expect(html).toContain(HOME_REFUSAL);
    // Hidden, link only and behind a password: every mode but "visible to everyone".
    expect(html.match(/disabled=""/g)?.length).toBe(3);
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
      // Never pre-filled: nothing can read a password back (0061).
      password: '',
      noteEn: '',
      noteAr: '',
    });
    expect(draftOf(hiddenAbout, HOME).redirect).toBe(HOME);
    expect(draftOf(template, HOME).redirect).toBe('');
  });

  it('the password option: a field that starts empty, the message in both languages', () => {
    const html = drawer(passwordAbout);
    expect(html).toContain('type="password"');
    // The stored message is editable; the password is not loaded, because it cannot be.
    expect(html).toContain('value="Ask the studio for the password."');
    expect(html).toMatch(/type="password"[^>]*value=""/);
    // Not the admin's own sign-in: a browser offers to save or replace that credential for
    // a field it takes for a login, and ignores "off" on a password field.
    expect(html).toMatch(/type="password"[^>]*autocomplete="new-password"/i);
    expect(html).toContain(PASSWORD_HINT);
    expect(html).toContain(PASSWORD_NOTE);
    expect(html).toContain(PASSWORD_REQUIRED);
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('Apply waits for a usable password, and asks nothing of the other modes', () => {
    const base = draftOf(passwordAbout, HOME);
    expect(draftReady({ ...base, mode: 'public' })).toBe(true);
    expect(draftReady({ ...base, password: '' })).toBe(false);
    expect(draftReady({ ...base, password: 'short7' })).toBe(false);
    expect(draftReady({ ...base, password: 'letmein22' })).toBe(true);
    // Bytes, not characters: bcrypt reads 72 bytes, and Arabic letters are two each.
    expect(draftReady({ ...base, password: 'ا'.repeat(37) })).toBe(false);
    expect(draftReady({ ...base, password: 'ا'.repeat(36) })).toBe(true);
  });

  it('a template is never offered a password (its children are linked from the lists)', () => {
    expect(drawer(template)).not.toContain('Behind a password');
  });
});

describe('the edge status line compares settings, not counts', () => {
  const list = (about: VisibilityItem, rev: string | null, count = 2) => ({
    pages: [page('home', HOME) as Extract<VisibilityItem, { kind: 'page' }>, about as never],
    templates: [template as Extract<VisibilityItem, { kind: 'template' }>],
    edge: { present: true, builtAt: null, count, rev },
  });

  it('agrees when the snapshot was built from these rows at these versions', () => {
    expect(edgeLine(list(hiddenAbout, 'row-a:2,row-t:1')).tone).toBe('info');
  });

  it('is behind when the counts match but a setting moved (hidden to link only, failed KV write)', () => {
    // The table now holds About as link only (version 3); the edge still has version 2.
    const linkAbout = page('about', ABOUT, {
      ...(hiddenAbout.setting as NonNullable<VisibilityItem['setting']>),
      mode: 'link',
      redirectPageId: null,
      hideFrom: null,
      showOn: null,
      version: 3,
    });
    const line = edgeLine(list(linkAbout, 'row-a:2,row-t:1'));
    expect(line).toEqual({
      tone: 'warn',
      text: 'The live site is behind these settings. Use Sync to edge.',
    });
  });

  it('is behind when the snapshot carries no revision', () => {
    expect(edgeLine(list(hiddenAbout, null)).tone).toBe('warn');
  });
});

describe('the copy promises no more than the edge keeps', () => {
  it('a few minutes: the memo, over KV’s edge cache, over KV’s propagation', () => {
    // KV propagates a write to every location within about a minute (Cloudflare's figure).
    const worstSeconds = VISIBILITY_MEMO_MS / 1000 + VISIBILITY_KV_CACHE_TTL_S + 60;
    expect(worstSeconds).toBeGreaterThan(60);
    expect(worstSeconds).toBeLessThanOrEqual(5 * 60);
    expect(APPLIES_WITHIN).toBe('Applies to the live site within a few minutes.');
    expect(CONFIRM_SUB).toBe('This changes the live site within a few minutes.');
    for (const file of [
      'src/lib/admin/visibilityCopy.ts',
      'src/pages/admin/visibility.astro',
      'src/components/admin/screens/visibility/VisibilityScreen.tsx',
      'src/components/admin/screens/visibility/VisibilityDrawer.tsx',
    ]) {
      expect(readFileSync(join(process.cwd(), file), 'utf8'), file).not.toMatch(/within a minute/);
    }
  });
});

describe('the copy keeps the client’s rules (P-12)', () => {
  it('no em or en dash, no brand', () => {
    const texts = [
      HOME_REFUSAL,
      ...Object.values(MODE_COPY).flatMap((c) => [c.title, c.text, c.badge]),
      ...Object.values(TEMPLATE_NOTE),
      HIDDEN_NOTE,
    ];
    for (const text of texts) {
      expect(text).not.toMatch(/[–—]/);
      expect(text.toLowerCase()).not.toMatch(/braii?n|statii?on/);
    }
  });
});
