import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import AvatarAstro from '@/components/admin/ui/Avatar.astro';
import BadgeAstro from '@/components/admin/ui/Badge.astro';
import EmptyStateAstro from '@/components/admin/ui/EmptyState.astro';
import IconAstro from '@/components/admin/ui/Icon.astro';
import KpiAstro from '@/components/admin/ui/Kpi.astro';
import ListRowAstro from '@/components/admin/ui/ListRow.astro';
import NoteAstro from '@/components/admin/ui/Note.astro';
import AvatarReact from '@/components/admin/kit/Avatar';
import EmptyStateReact from '@/components/admin/kit/EmptyState';
import IconReact from '@/components/admin/kit/Icon';
import KpiReact from '@/components/admin/kit/Kpi';
import ListRowReact from '@/components/admin/kit/ListRow';
import NoteReact from '@/components/admin/kit/Note';
import { Badge as BadgeReact } from '@/components/admin/kit/StatusBadge';

// The pieces that exist twice (Admin v2 F4b): a server primitive for zero-JS pages and a
// React twin for islands. A badge, an avatar or a note must read the same wherever it is
// drawn, so each pair is rendered with the same input and compared as markup (attribute
// order and the whitespace between tags aside).

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});

/** Markup with each tag's attributes sorted and the whitespace between tags dropped. */
function canonical(html: string): string {
  return html
    .replace(
      /<([a-zA-Z][\w-]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*(\/?)>/g,
      (_, tag, attrs, self) => {
        const list = [...String(attrs).matchAll(/\s+([^\s=>]+)(?:="([^"]*)")?/g)]
          .map(([, name, value]) => `${name}="${value ?? ''}"`)
          .sort();
        return `<${tag}${list.map((a) => ` ${a}`).join('')}${self ? ' /' : ''}>`;
      },
    )
    .replace(/>\s+</g, '><')
    .replace(/>\s+/g, '>')
    .replace(/\s+</g, '<')
    .trim();
}

type Factory = Parameters<AstroContainer['renderToString']>[0];

async function astro(
  component: Factory,
  props: Record<string, unknown>,
  slots: Record<string, string> = {},
) {
  return canonical(await container.renderToString(component, { props, slots }));
}

function react<P extends object>(component: ComponentType<P>, props: P) {
  return canonical(renderToStaticMarkup(createElement(component, props)));
}

describe('server primitives and their React twins render the same markup', () => {
  it('the comparison is not vacuous: it keeps tags, attributes and text', async () => {
    expect(await astro(BadgeAstro, { status: 'draft' })).toBe(
      '<span class="badge" data-status="draft">Draft</span>',
    );
    expect(await astro(BadgeAstro, { status: 'draft' })).not.toBe(
      react(BadgeReact, { status: 'published' }),
    );
    expect(await astro(ListRowAstro, { title: 'A', hidden: true })).not.toBe(
      react(ListRowReact, { title: 'A' }),
    );
  });

  it('Icon', async () => {
    expect(await astro(IconAstro, { name: 'trash', size: 15 })).toBe(
      react(IconReact, { name: 'trash', size: 15 }),
    );
  });

  it('Badge: a status, a tone, a plain count', async () => {
    expect(await astro(BadgeAstro, { status: 'scheduled' })).toBe(
      react(BadgeReact, { status: 'scheduled' }),
    );
    expect(await astro(BadgeAstro, { tone: 'err' }, { default: 'Overdue' })).toBe(
      react(BadgeReact, { tone: 'err', children: 'Overdue' }),
    );
    expect(await astro(BadgeAstro, { plain: true }, { default: '12' })).toBe(
      react(BadgeReact, { plain: true, children: '12' }),
    );
  });

  it('Avatar: decorative and named', async () => {
    const decorative = { name: 'Content Team', toneKey: 'user-7', size: 'sm' as const };
    expect(await astro(AvatarAstro, decorative)).toBe(react(AvatarReact, decorative));
    const named = { initials: 'AB', label: 'Sample person' };
    expect(await astro(AvatarAstro, named)).toBe(react(AvatarReact, named));
  });

  it('Note', async () => {
    expect(await astro(NoteAstro, { tone: 'warn', role: 'status' }, { default: '<p>Hi</p>' })).toBe(
      react(NoteReact, {
        tone: 'warn',
        role: 'status',
        children: createElement('p', null, 'Hi'),
      }),
    );
  });

  it('EmptyState', async () => {
    expect(await astro(EmptyStateAstro, { title: 'Nothing yet', text: 'Add one.' })).toBe(
      react(EmptyStateReact, { title: 'Nothing yet', text: 'Add one.' }),
    );
  });

  it('ListRow: a linked row, and a hidden current one', async () => {
    const linked = { title: 'Hero', sub: 'Banner', href: '/x', icon: 'layers' as const };
    expect(await astro(ListRowAstro, linked)).toBe(react(ListRowReact, linked));
    const hidden = { title: 'Clients', hidden: true, current: true };
    expect(await astro(ListRowAstro, hidden)).toBe(react(ListRowReact, hidden));
  });

  it('Kpi: a figure, a unit, the change pill with its spoken words, and none (C4b)', async () => {
    const plain = { label: 'New', value: 1234 };
    expect(await astro(KpiAstro, plain)).toBe(react(KpiReact, plain));
    const full = {
      label: 'Won',
      value: 3,
      unit: '50,000 SAR',
      delta: 25,
      period: 'the previous 7 days',
    };
    expect(await astro(KpiAstro, full)).toBe(react(KpiReact, full));
    expect(react(KpiReact, full)).toContain('Up 25% vs the previous 7 days');
    const down = {
      label: 'Average first response',
      value: '3 h 40 min',
      delta: -12,
      good: 'down' as const,
    };
    expect(await astro(KpiAstro, down)).toBe(react(KpiReact, down));
    const points = {
      label: 'Won of all leads',
      value: '20%',
      delta: 4,
      deltaUnit: 'points' as const,
    };
    expect(await astro(KpiAstro, points)).toBe(react(KpiReact, points));
  });
});
