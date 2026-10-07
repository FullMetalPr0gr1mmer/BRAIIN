import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Icon from '@/components/admin/kit/Icon';
import { ICON_NAMES, ICON_SPRITE } from '@/lib/admin/icons';

// The admin icon sprite (Admin v2 F1): the client's prototype set as one same-origin SVG.
// A component asks for an icon by name, so the names list and the sprite must be the same
// set; the sprite must carry no style (style-src is nonce-only) and draw in currentColor
// so an icon takes the colour of the text around it.

const SPRITE = readFileSync('public/styles/admin-icons.svg', 'utf8');
const symbols = [...SPRITE.matchAll(/<symbol\b([^>]*)>/g)].map((m) => m[1] ?? '');

describe('the icon sprite', () => {
  it('holds exactly the named icons, in order', () => {
    const ids = symbols.map((attrs) => /\bid="i-([a-z]+)"/.exec(attrs)?.[1]);
    expect(ids).toEqual([...ICON_NAMES]);
  });

  it('draws each icon on the 24px grid in the text colour', () => {
    for (const attrs of symbols) {
      expect(attrs).toContain('viewBox="0 0 24 24"');
      expect(attrs).toContain('stroke="currentColor"');
      expect(attrs).toContain('fill="none"');
    }
  });

  it('carries no style and no script', () => {
    const markup = SPRITE.replace(/<!--[\s\S]*?-->/g, '');
    expect(markup).not.toMatch(/\sstyle\s*=|<style\b/i);
    expect(markup).not.toMatch(/<script/i);
  });

  it('is served from the public styles folder', () => {
    expect(ICON_SPRITE).toBe('/styles/admin-icons.svg');
  });
});

describe('Icon (islands)', () => {
  it('references the sprite and sizes with attributes, never a style', () => {
    const html = renderToStaticMarkup(createElement(Icon, { name: 'search', size: 16 }));
    expect(html).toContain('<use href="/styles/admin-icons.svg#i-search">');
    expect(html).toContain('width="16"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('style=');
  });

  it('is named, not hidden, when it is the only label', () => {
    const html = renderToStaticMarkup(
      createElement(Icon, { name: 'bell', label: 'Notifications' }),
    );
    expect(html).toContain('aria-label="Notifications"');
    expect(html).toContain('role="img"');
    expect(html).not.toContain('aria-hidden');
  });
});

describe('Icon.astro', () => {
  it('emits the same markup as Icon.tsx', () => {
    const src = readFileSync('src/components/admin/ui/Icon.astro', 'utf8');
    expect(src).toContain('<use href={`${ICON_SPRITE}#i-${name}`}>');
    expect(src).toMatch(/width=\{size\}/);
    expect(src).not.toMatch(/\sstyle=/);
  });
});
