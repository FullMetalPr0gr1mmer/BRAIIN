import { describe, expect, test } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import BaseLayout from '@/layouts/BaseLayout.astro';
import { IDENTITY } from './fixtures';
import { normalise } from './harness';

// BaseLayout's preview mode (Admin v2 R9), rendered: the bridge's script is in the <head>,
// ahead of every script the page renders. Module scripts run in document order, so the bridge
// has replaced fetch and sendBeacon before a page script can call them at start-up (the search
// page runs an initial `?q=` at once, and /api/search records every query). A public render
// carries no bridge at all.

const BRIDGE = 'AdminPreviewBridge.astro?astro&type=script';

async function render(preview: boolean): Promise<string> {
  const container = await AstroContainer.create();
  const html = await container.renderToString(BaseLayout, {
    props: {
      title: 'Search',
      description: 'Search the site',
      locale: 'en',
      logicalPath: '/search',
      chrome: false,
    },
    // A page's own script, where a page renders it: inside the body.
    slots: { default: '<main><script type="module" src="/page-script.js"></script></main>' },
    request: new Request('https://www.example.test/search?q=logo'),
    locals: {
      identity: Promise.resolve(IDENTITY),
      ...(preview ? { preview: { locale: 'en', path: '/admin/preview/search' } } : {}),
    } as App.Locals,
  });
  return normalise(html);
}

const scripts = (html: string) =>
  [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1] ?? '');

describe('BaseLayout in a preview', () => {
  test('the bridge is the first script, in the head, before the page’s own', async () => {
    const html = await render(true);
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain(BRIDGE);
    const order = scripts(html);
    expect(order[0], order.join('\n')).toContain(BRIDGE);
    expect(order.filter((s) => s.includes(BRIDGE))).toHaveLength(1);
    expect(order.indexOf('/page-script.js')).toBeGreaterThan(0);
  });

  test('a public render carries no bridge', async () => {
    const html = await render(false);
    expect(html).not.toContain('AdminPreviewBridge');
  });
});
