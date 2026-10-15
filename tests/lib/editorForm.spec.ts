import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EntitySave } from '@/lib/admin/useEntitySave';
import { RESOURCE_UI, SINGLETON_UI, type FieldDef } from '@/lib/admin/uiSchema';

vi.mock('@/components/admin/RichText', () => ({ default: () => null }));

const { default: EditorForm } = await import('@/components/admin/fields/EditorForm');

// EditorForm (Admin v2 F5a) draws what every editor draws around its fields, from the save
// useEntitySave hands it. Rendered on the server here with a save in each state: what an
// editor sees is the same whichever screen it is on. The state machine itself is
// tests/lib/entitySave.spec.ts.

const FIELDS: FieldDef[] = [
  { name: 'slug', label: 'Slug', kind: 'slug', required: true },
  { name: 'title', label: 'Service name', kind: 'bilingual', required: true },
];

function fakeSave(patch: Partial<EntitySave> = {}): EntitySave {
  return {
    isNew: false,
    values: { slug: 'logo', title: { en: 'Logo', ar: 'الشعار' } },
    set: () => undefined,
    version: 4,
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
    ...patch,
  };
}

const render = (save: EntitySave, fields: readonly FieldDef[] = FIELDS, extra = {}) =>
  renderToStaticMarkup(
    createElement(EditorForm, { save, fields, submitLabel: 'Save changes', ...extra }),
  );

describe('EditorForm', () => {
  it('the fields, the language bar for a bilingual form, Save, the way back and the version', () => {
    const html = render(fakeSave(), FIELDS, {
      back: { href: '/admin/services', label: 'Back to services' },
    });
    expect(html).toMatch(/<form class="editor" novalidate="">/i);
    expect(html).toContain('id="f-slug"');
    expect(html).toContain('id="f-title-ar"');
    expect(html).toContain('<legend class="visually-hidden">Editing language</legend>');
    expect(html).toContain('<button type="submit" data-variant="primary">Save changes</button>');
    expect(html).toContain('<a class="btn" href="/admin/services">Back to services</a>');
    expect(html).toContain('Version 4');
    expect(html).toContain('class="save-status" data-state="idle" role="status"');
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('no language bar for a form with no bilingual field', () => {
    const html = render(fakeSave(), [FIELDS[0]!]);
    expect(html).not.toContain('Editing language');
  });

  it('a singleton never saved says "Not saved yet"; a new record shows no version', () => {
    expect(render(fakeSave({ version: 0 }))).toContain('Not saved yet');
    const fresh = render(fakeSave({ isNew: true, version: 0 }));
    expect(fresh).not.toContain('Not saved yet');
    expect(fresh).not.toContain('Version');
  });

  it('a 409: the banner and "Reload their version"', () => {
    const html = render(fakeSave({ conflict: true, status: 'error' }));
    expect(html).toContain('Someone else saved changes while you were editing.');
    expect(html).toContain('<button type="button">Reload their version</button>');
    expect(html).toContain('Not saved');
  });

  it('a 422: the ErrorSummary first in the form, the field marked inline', () => {
    const html = render(
      fakeSave({
        status: 'error',
        values: { slug: 'logo', title: { en: 'Logo', ar: '' } },
        errors: {
          byId: { 'f-title-ar': 'Required' },
          summary: [{ id: 'f-title-ar', message: 'Service name (Arabic): Required' }],
        },
      }),
    );
    expect(html).toMatch(/^<form[^>]*><div class="error-summary" role="alert"/);
    expect(html).toContain('<a href="#f-title-ar">Service name (Arabic): Required</a>');
    expect(html).toContain('aria-invalid="true"');
  });

  it('a refusal not about one field is said in words', () => {
    expect(
      render(fakeSave({ status: 'error', message: 'Your role does not allow that.' })),
    ).toContain('<p class="msg" data-kind="error" role="alert">Your role does not allow that.</p>');
  });

  it('loading, and a failed load (no form to save blanks over a row it never read)', () => {
    expect(render(fakeSave({ busy: true }))).toBe('<p class="admin-sub">Loading…</p>');
    const failed = render(fakeSave({ loadError: 'That item no longer exists.' }));
    expect(failed).toContain('That item no longer exists.');
    expect(failed).not.toContain('<form');
    // Saving keeps the form on screen, Save disabled while it goes.
    const saving = render(fakeSave({ busy: true, status: 'saving' }));
    expect(saving).toContain('<button type="submit" data-variant="primary" disabled="">');
  });

  it('every resource and singleton editor renders through it, with unique ids and no style attribute', () => {
    const editors = [...Object.values(RESOURCE_UI), ...Object.values(SINGLETON_UI)];
    for (const ui of editors) {
      const html = render(fakeSave({ values: { type: 'cta' } }), ui.fields);
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(ids).size, ui.title).toBe(ids.length);
      expect(html, ui.title).not.toMatch(/\sstyle=/);
    }
  });
});
