import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EntitySave } from '@/lib/admin/useEntitySave';
import { notificationSwitches } from '@/lib/admin/notificationSettings';
import { NOTIFICATION_KIND_LABELS } from '@/lib/admin/notifications/kinds';

// /admin/settings/notifications's island (Admin v2 U11), rendered on the server with its row
// loaded: the prototype's one card, "In-admin notifications" over "The bell at the top"
// (screens_ops.js), holding one switch per kind the role's bell shows. The save itself is
// tests/lib/entitySave.spec.ts; the switches per role are notificationSettings.spec.ts.

const loaded = (values: Record<string, unknown>): EntitySave => ({
  isNew: false,
  values,
  saved: values,
  set: () => undefined,
  version: 2,
  busy: false,
  loadError: null,
  status: 'idle',
  savedAt: null,
  errors: { byId: {}, summary: [] },
  conflict: false,
  edgeMissed: false,
  dirty: false,
  message: null,
  save: async () => true,
  reloadTheirs: async () => undefined,
  adoptVersion: () => undefined,
});

const state = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock('@/lib/admin/useEntitySave', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/useEntitySave')>()),
  useEntitySave: () => loaded(state.values),
}));

const { default: NotificationSettingsScreen, NOTIFICATION_SETTINGS_CARD } =
  await import('@/components/admin/screens/notificationSettings/NotificationSettingsScreen');

describe('the bell settings island', () => {
  it('is one card named as the prototype names it, the switches inside it', () => {
    const switches = notificationSwitches('developer');
    state.values = Object.fromEntries(switches.map((s) => [s.kind, true]));
    const html = renderToStaticMarkup(createElement(NotificationSettingsScreen, { switches }));
    expect(NOTIFICATION_SETTINGS_CARD).toEqual({
      title: 'In-admin notifications',
      sub: 'The bell at the top',
    });
    expect(html).toContain(
      '<div class="card"><div class="card__h"><div><h2 class="card__t">In-admin notifications</h2><p class="card__sub">The bell at the top</p></div></div>',
    );
    const card = html.slice(html.indexOf('<div class="card">'));
    for (const s of switches) {
      expect(card, s.kind).toContain(`id="f-${s.kind}"`);
      expect(card, s.kind).toContain(NOTIFICATION_KIND_LABELS[s.kind].label);
      expect(s.label).toBe(NOTIFICATION_KIND_LABELS[s.kind].label);
    }
    expect(html).not.toMatch(/\sstyle=/);
  });
});
