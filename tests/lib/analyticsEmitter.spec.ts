import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The public analytics emitter (src/lib/client/analytics.ts, Admin v2 G1), on a hand-made
// stand-in for the browser (the unit project has no DOM): a document that is an EventTarget,
// elements that answer `closest`, a consent cookie, sessionStorage and sendBeacon recorded.
// Held here: no beacon without analytics consent (clicks and the explorer's events included),
// one click beacon per id per page view, one interest beacon per key, never a click inside a
// form, and the page view on `pageshow` and on opting in.

class FakeElement {
  constructor(
    private readonly attrs: Record<string, string>,
    private readonly parent: FakeElement | null = null,
    readonly tag = 'a',
  ) {}
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  closest(selector: string): FakeElement | null {
    for (let el: FakeElement | null = this; el; el = el.parent) {
      if (selector === 'form' && el.tag === 'form') return el;
      if (selector === '[data-track]' && el.attrs['data-track'] !== undefined) return el;
    }
    return null;
  }
}

interface Beacon {
  type: string;
  path: string;
  locale: string;
  sessionId?: string;
  props?: Record<string, string>;
}

let beacons: Beacon[];
let pending: Promise<unknown>[];
let cookie: string;
let doc: EventTarget & { cookie: string; documentElement: { lang: string } };
let win: EventTarget;

async function load() {
  vi.resetModules();
  return import('@/lib/client/analytics');
}

function click(target: FakeElement) {
  const event = new Event('click', { bubbles: true });
  Object.defineProperty(event, 'target', { value: target });
  doc.dispatchEvent(event);
}

beforeEach(() => {
  beacons = [];
  pending = [];
  cookie = '';
  const target = new EventTarget();
  // defineProperty, not Object.assign: assign would copy the getter's value once.
  Object.defineProperty(target, 'cookie', { get: () => cookie });
  Object.defineProperty(target, 'documentElement', { value: { lang: 'ar' } });
  doc = target as typeof doc;
  win = new EventTarget();
  const store = new Map<string, string>();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal('addEventListener', win.addEventListener.bind(win));
  vi.stubGlobal('location', { pathname: '/ar/contact' });
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.stubGlobal('navigator', {
    sendBeacon: (_url: string, blob: Blob) => {
      pending.push(blob.text().then((text) => beacons.push(JSON.parse(text) as Beacon)));
      return true;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const consent = (analytics: boolean) => {
  cookie = `other=1; __Host-consent=${encodeURIComponent(JSON.stringify({ analytics }))}`;
};
const flush = () => Promise.all(pending);

describe('the analytics emitter', () => {
  it('sends nothing without analytics consent: no page view, no click, no interest', async () => {
    const { initAnalytics, interest } = await load();
    initAnalytics();
    win.dispatchEvent(new Event('pageshow'));
    click(new FakeElement({ 'data-track': 'whatsapp' }));
    interest({ discipline: 'branding' });
    consent(false);
    click(new FakeElement({ 'data-track': 'email' }));
    await flush();
    expect(beacons).toEqual([]);
  });

  it('a page view on pageshow, once; opting in later counts the page then', async () => {
    const { initAnalytics } = await load();
    initAnalytics();
    win.dispatchEvent(new Event('pageshow'));
    consent(true);
    doc.dispatchEvent(new Event('consent-updated'));
    win.dispatchEvent(new Event('pageshow'));
    await flush();
    expect(beacons).toHaveLength(1);
    expect(beacons[0]).toMatchObject({ type: 'pageview', path: '/ar/contact', locale: 'ar' });
    expect(beacons[0]!.sessionId).toMatch(/^[a-z0-9]+$/);
    expect(beacons[0]!.props).toBeUndefined();
  });

  it('one click beacon per id per page view, the id as its only prop', async () => {
    consent(true);
    const { initAnalytics } = await load();
    initAnalytics();
    initAnalytics(); // idempotent: one listener
    const link = new FakeElement({ 'data-track': 'whatsapp' });
    const inner = new FakeElement({}, link, 'span');
    click(inner);
    click(link);
    click(new FakeElement({ 'data-track': 'email' }));
    click(new FakeElement({}));
    await flush();
    expect(beacons.map((b) => [b.type, b.props])).toEqual([
      ['cta_click', { cta: 'whatsapp' }],
      ['cta_click', { cta: 'email' }],
    ]);
    expect(beacons[0]!.path).toBe('/ar/contact');
  });

  it('never a click inside a form (no event from the contact form)', async () => {
    consent(true);
    const { initAnalytics } = await load();
    initAnalytics();
    const form = new FakeElement({}, null, 'form');
    click(new FakeElement({ 'data-track': 'contact_link' }, form));
    await flush();
    expect(beacons).toEqual([]);
  });

  it('interest: one beacon per discipline or service, exactly one key each', async () => {
    consent(true);
    const { initAnalytics, interest } = await load();
    initAnalytics();
    interest({ discipline: 'branding' });
    interest({ discipline: 'branding' });
    interest({ service: 'logo-design' });
    interest({ discipline: 'marketing' });
    doc.dispatchEvent(new CustomEvent('bs:interest', { detail: null }));
    doc.dispatchEvent(new CustomEvent('bs:interest', { detail: { discipline: 7 } }));
    await flush();
    expect(beacons.map((b) => b.props)).toEqual([
      { discipline: 'branding' },
      { service: 'logo-design' },
      { discipline: 'marketing' },
    ]);
    expect(beacons.every((b) => b.type === 'service_interest')).toBe(true);
  });

  it('reads consent from the cookie, a malformed one as no', async () => {
    const { analyticsConsent } = await load();
    expect(analyticsConsent('')).toBe(false);
    expect(analyticsConsent('__Host-consent=%7Bbroken')).toBe(false);
    expect(analyticsConsent('__Host-consent=%7B%22analytics%22%3Atrue%7D')).toBe(true);
    expect(analyticsConsent('__Host-consent=%7B%22analytics%22%3A%22yes%22%7D')).toBe(false);
  });
});

describe('the explorer dispatches interest only for what the visitor opens', () => {
  it('a service row link names its service; another link names none', async () => {
    const { serviceSlugOf } = await import('@/lib/client/serviceExplorer');
    expect(serviceSlugOf('/services/logo-design')).toBe('logo-design');
    expect(serviceSlugOf('/ar/services/logo-design#inquiry')).toBe('logo-design');
    expect(serviceSlugOf('/services')).toBeNull();
    expect(serviceSlugOf('/contact')).toBeNull();
    expect(serviceSlugOf('https://evil.test/services/x')).toBeNull();
  });

  it('the panel a URL opened at load dispatches nothing; tabs, cards, prev/next and hashes do', () => {
    const source = readFileSync('src/lib/client/serviceExplorer.ts', 'utf8');
    // The hand-over opens without `interest`; every visitor path passes it.
    const opens = [...source.matchAll(/\bopen\(([^;]*?)\);/g)].map((m) => m[1]!);
    const handOver = opens.filter((o) => o.includes('animate: false'));
    expect(handOver).toHaveLength(2);
    for (const o of handOver) expect(o).not.toContain('interest');
    const visitor = opens.filter((o) => !o.includes('animate: false'));
    expect(visitor).toHaveLength(3);
    for (const o of visitor) expect(o).toContain('interest: true');
  });
});
