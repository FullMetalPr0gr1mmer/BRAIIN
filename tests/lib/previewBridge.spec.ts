import { describe, expect, it, vi } from 'vitest';
import {
  FromPreviewMessageSchema,
  ToPreviewMessageSchema,
  type FromPreviewMessage,
} from '@schemas/previewMessage';
import {
  acceptToPreview,
  postToParent,
  previewHrefFor,
  READ_ONLY_ENDPOINTS,
  requestAllowed,
  sectionsOf,
} from '@/lib/admin/preview/bridge';
import { acceptFromPreview, createPreviewChannel } from '@/lib/admin/previewChannel';

// The preview bridge (Admin v2 R9, P-4; CLAUDE.md §3 postMessage): the Zod envelope, an
// explicit same-origin targetOrigin, origin AND source checked on both sides, link and
// request interception, and theme tokens as CSS custom properties only.

const ORIGIN = 'https://www.example.test';
const parent = { postMessage: vi.fn() };

describe('the envelope (packages/schemas/previewMessage.ts)', () => {
  it('accepts each parent message of version 1', () => {
    for (const m of [
      { v: 1, type: 'jump', sectionId: '5eed5000-0000-4000-8000-000000000001' },
      { v: 1, type: 'highlight', sectionId: null },
      { v: 1, type: 'highlight', sectionId: 'default-3' },
      { v: 1, type: 'scroll', y: 120 },
      { v: 1, type: 'reload' },
      { v: 1, type: 'tokens', tokens: { '--bs-klein': '#0024BC' } },
    ]) {
      expect(ToPreviewMessageSchema.safeParse(m).success, JSON.stringify(m)).toBe(true);
    }
  });

  it('refuses another version, an unknown type, an extra key, or a section id that is markup', () => {
    for (const m of [
      { v: 2, type: 'reload' },
      { v: 1, type: 'eval', code: 'x' },
      { v: 1, type: 'reload', html: '<b>' },
      { v: 1, type: 'jump', sectionId: '"] , body { x' },
      { v: 1, type: 'scroll', y: -1 },
      { v: 1, type: 'scroll', y: Number.POSITIVE_INFINITY },
      '{"v":1,"type":"reload"}',
      null,
    ]) {
      expect(ToPreviewMessageSchema.safeParse(m).success, JSON.stringify(m)).toBe(false);
    }
  });

  it('tokens are CSS custom properties with values that cannot leave a declaration', () => {
    const bad = [
      { color: 'red' },
      { '--x': 'red; } body { display:none' },
      { '--x': 'red</style><script>' },
      { '--X': 'red' },
    ];
    for (const tokens of bad) {
      expect(ToPreviewMessageSchema.safeParse({ v: 1, type: 'tokens', tokens }).success).toBe(
        false,
      );
    }
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`--t${i}`, '1']));
    expect(ToPreviewMessageSchema.safeParse({ v: 1, type: 'tokens', tokens: many }).success).toBe(
      false,
    );
  });

  it('the preview reports only paths inside the preview', () => {
    const ok: FromPreviewMessage = {
      v: 1,
      type: 'ready',
      path: '/admin/preview/ar/about?x=1',
      locale: 'ar',
      sections: [{ id: 'default-0', anchor: 'who' }],
    };
    expect(FromPreviewMessageSchema.safeParse(ok).success).toBe(true);
    for (const path of ['/about', 'https://evil.test/admin/preview', '/admin/previewx', '//x']) {
      expect(FromPreviewMessageSchema.safeParse({ v: 1, type: 'navigate', path }).success).toBe(
        false,
      );
    }
  });
});

describe('the preview side', () => {
  const event = (data: unknown, origin = ORIGIN, source: unknown = parent) => ({
    data,
    origin,
    source,
  });
  const expected = { origin: ORIGIN, source: parent };

  it('takes a message only from its own origin and its parent window, parsed', () => {
    expect(acceptToPreview(event({ v: 1, type: 'reload' }), expected)).toEqual({
      v: 1,
      type: 'reload',
    });
    expect(acceptToPreview(event({ v: 1, type: 'reload' }, 'https://evil.test'), expected)).toBe(
      null,
    );
    expect(acceptToPreview(event({ v: 1, type: 'reload' }, ORIGIN, {}), expected)).toBe(null);
    expect(acceptToPreview(event({ v: 1, type: 'nope' }), expected)).toBe(null);
    // Opened on its own (no parent): nothing is accepted, even from itself.
    expect(
      acceptToPreview(event({ v: 1, type: 'reload' }, ORIGIN, null), {
        origin: ORIGIN,
        source: null,
      }),
    ).toBe(null);
  });

  it('posts to the parent with its own origin as targetOrigin, never *, and only valid messages', () => {
    const target = { postMessage: vi.fn() };
    expect(postToParent(target, ORIGIN, { v: 1, type: 'scroll', y: 10 })).toBe(true);
    expect(target.postMessage).toHaveBeenCalledWith({ v: 1, type: 'scroll', y: 10 }, ORIGIN);
    expect(postToParent(target, ORIGIN, { v: 1, type: 'navigate', path: '/about' } as never)).toBe(
      false,
    );
    expect(target.postMessage).toHaveBeenCalledTimes(1);
    expect(postToParent(null, ORIGIN, { v: 1, type: 'scroll', y: 1 })).toBe(false);
  });

  it('keeps a same-origin page link inside the preview, with the selection', () => {
    const base = `${ORIGIN}/admin/preview/ar?only=0d000000-0000-4000-8000-000000000001`;
    expect(previewHrefFor('/ar/services/logo#cases', base)).toBe(
      '/admin/preview/ar/services/logo?only=0d000000-0000-4000-8000-000000000001#cases',
    );
    expect(previewHrefFor(`${ORIGIN}/portfolio/all?service=logo`, `${ORIGIN}/admin/preview`)).toBe(
      '/admin/preview/portfolio/all?service=logo',
    );
  });

  it('leaves alone an anchor on this page, another site, a feed and the admin', () => {
    const base = `${ORIGIN}/admin/preview/about`;
    for (const href of [
      '#who',
      'https://evil.test/about',
      '/creative-knowledge/rss.xml',
      '/admin/pages',
      '/admin/preview/services',
      'mailto:hello@example.test',
      'javascript:alert(1)',
    ]) {
      expect(previewHrefFor(href, base), href).toBeNull();
    }
  });

  it('lets a script read, never write: GET and HEAD only', () => {
    expect(requestAllowed('/api/apply/status')).toBe(true);
    expect(requestAllowed('/x', { method: 'head' })).toBe(true);
    expect(requestAllowed('/api/contact', { method: 'POST' })).toBe(false);
    expect(requestAllowed(new Request(`${ORIGIN}/api/contact`, { method: 'PUT' }))).toBe(false);
  });

  it('refuses a read of an API endpoint that writes: a preview search records nothing', () => {
    const base = `${ORIGIN}/admin/preview/search`;
    // /api/search records every query (recordSearchQuery): a preview must not reach it.
    expect(requestAllowed('/api/search?q=logo&locale=en', undefined, base)).toBe(false);
    expect(requestAllowed(`${ORIGIN}/api/search?q=logo`, { method: 'GET' }, base)).toBe(false);
    expect(requestAllowed(new URL('/api/search/?q=x', ORIGIN), undefined, base)).toBe(false);
    expect(requestAllowed(new Request(`${ORIGIN}/api/search?q=x`), undefined, base)).toBe(false);
    expect(requestAllowed('/api', { method: 'HEAD' }, base)).toBe(false);
    expect(requestAllowed('/API/Search?q=x', undefined, base)).toBe(false);
    expect(requestAllowed('/api/%73earch?q=x', undefined, base)).toBe(false);
    // An endpoint that writes nothing still answers, and so does anything outside the API.
    expect(requestAllowed('/api/apply/status', undefined, base)).toBe(true);
    expect(requestAllowed('/styles/preview.css', undefined, base)).toBe(true);
    expect(requestAllowed('/apix', undefined, base)).toBe(true);
    for (const path of READ_ONLY_ENDPOINTS) expect(path.startsWith('/api/')).toBe(true);
  });

  it('lists the marked sections, skipping a marker that is not an id', () => {
    const el = (id: string, anchor = '') => ({
      id: anchor,
      getAttribute: (n: string) => (n === 'data-pv-section' ? id : null),
    });
    const doc = {
      querySelectorAll: () => [el('default-0', 'who'), el('"><x'), el('abc-1', '1bad')],
    } as unknown as Pick<Document, 'querySelectorAll'>;
    expect(sectionsOf(doc)).toEqual([
      { id: 'default-0', anchor: 'who' },
      { id: 'abc-1', anchor: null },
    ]);
  });
});

describe('the parent side (src/lib/admin/previewChannel.ts)', () => {
  function host() {
    const listeners: ((e: { origin: string; source: unknown; data: unknown }) => void)[] = [];
    return {
      location: { origin: ORIGIN },
      addEventListener: (_: 'message', l: (typeof listeners)[number]) => listeners.push(l),
      removeEventListener: (_: 'message', l: (typeof listeners)[number]) =>
        listeners.splice(listeners.indexOf(l), 1),
      fire: (e: { origin: string; source: unknown; data: unknown }) =>
        listeners.forEach((l) => l(e)),
      listeners,
    };
  }

  it('posts to the frame with its own origin, and only valid messages', () => {
    const frame = { contentWindow: { postMessage: vi.fn() } };
    const channel = createPreviewChannel(frame, host(), () => undefined);
    expect(channel.send({ v: 1, type: 'reload' })).toBe(true);
    expect(frame.contentWindow.postMessage).toHaveBeenCalledWith({ v: 1, type: 'reload' }, ORIGIN);
    expect(channel.send({ v: 1, type: 'tokens', tokens: { color: 'red' } } as never)).toBe(false);
    expect(frame.contentWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(
      createPreviewChannel({ contentWindow: null }, host(), () => undefined).send({
        v: 1,
        type: 'reload',
      }),
    ).toBe(false);
  });

  it('hears only its own frame, from its own origin, and stops when closed', () => {
    const frame = { contentWindow: { postMessage: vi.fn() } };
    const h = host();
    const heard: unknown[] = [];
    const channel = createPreviewChannel(frame, h, (m) => heard.push(m));
    const msg = { v: 1, type: 'scroll', y: 5 };
    h.fire({ origin: ORIGIN, source: frame.contentWindow, data: msg });
    h.fire({ origin: 'https://evil.test', source: frame.contentWindow, data: msg });
    h.fire({ origin: ORIGIN, source: {}, data: msg });
    h.fire({ origin: ORIGIN, source: frame.contentWindow, data: { ...msg, extra: 1 } });
    expect(heard).toEqual([msg]);
    channel.close();
    expect(h.listeners).toHaveLength(0);
    expect(
      acceptFromPreview(
        { origin: ORIGIN, source: null, data: msg },
        { origin: ORIGIN, source: null },
      ),
    ).toBeNull();
  });
});
