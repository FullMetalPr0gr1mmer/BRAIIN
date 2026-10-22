import { readFileSync } from 'node:fs';
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
  // What is stored follows what is shown unless a test says otherwise (an unsaved edit).
  const values = patch.values ?? { slug: 'logo', title: { en: 'Logo', ar: 'الشعار' } };
  return {
    isNew: false,
    values,
    saved: values,
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
    adoptVersion: () => undefined,
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

  it('a heading is the header band of the fields card; without one the card has none (U11)', () => {
    const html = render(fakeSave(), [FIELDS[0]!], {
      heading: { title: 'In-admin notifications', sub: 'The bell at the top' },
    });
    expect(html).toContain(
      '<div class="card"><div class="card__h"><div><h2 class="card__t">In-admin notifications</h2><p class="card__sub">The bell at the top</p></div></div>',
    );
    // The header comes before the fields, inside their card.
    expect(html.indexOf('card__h')).toBeLessThan(html.indexOf('id="f-slug"'));
    expect(render(fakeSave(), [FIELDS[0]!])).not.toContain('card__h');
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

describe('the ErrorSummary’s links are 24px targets (WCAG 2.5.8; F5a CI axe target-size)', () => {
  it('admin.css gives each link a 24px block size of its own', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../../public/styles/admin.css', import.meta.url), 'utf8');
    const rule = /\.error-summary a\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/display:\s*inline-block/);
    const size = Number(/min-block-size:\s*(\d+)px/.exec(rule)?.[1]);
    expect(size).toBeGreaterThanOrEqual(24);
  });
});

describe('EditorForm in tabs and read-only (Admin v2 U8b)', () => {
  const blog = RESOURCE_UI['blog']!;
  const values = {
    title: { en: 'Colour', ar: 'اللون' },
    slug: 'colour',
    status: 'published',
    authorId: '',
  };
  const tabbed = (patch: Partial<EntitySave> = {}, extra: Record<string, unknown> = {}) =>
    render(fakeSave({ values, ...patch }), blog.fields, {
      tabs: blog.tabs,
      tabsLabel: 'Post editor',
      panels: { seo: createElement('p', null, 'THE SEO PANEL') },
      ...extra,
    });

  it('a tab list above the form; field tabs inside it, the others hidden; the panel tab after it', () => {
    const html = tabbed();
    expect(html).toMatch(
      /^<div class="editor-tabs"><div class="seg" role="tablist" aria-label="Post editor">/,
    );
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Content</);
    const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
    expect(form).toMatch(/data-editor-tab="content"(?![^>]*hidden)/);
    expect(form).toMatch(/data-editor-tab="publishing" hidden=""/);
    expect(form).not.toContain('data-editor-tab="seo"');
    expect(form).toContain('id="f-authorId"');
    expect(form).toContain('id="f-status"');
    const after = html.slice(html.indexOf('</form>'));
    expect(after).toMatch(/data-editor-tab="seo" hidden=""><\/div>/);
    // Not opened yet: the panel mounts the first time its tab opens.
    expect(html).not.toContain('THE SEO PANEL');
    expect(html).toMatch(/<form class="editor" novalidate="">/i);
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('every tab controls its panel, and every panel is named by its tab', () => {
    const html = tabbed();
    const controls = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1]);
    expect(controls).toHaveLength(3);
    for (const id of controls) expect(html).toContain(`id="${id}"`);
    for (const m of html.matchAll(/role="tabpanel" id="[^"]+" aria-labelledby="([^"]+)"/g)) {
      expect(html).toContain(`id="${m[1]}"`);
    }
  });

  it('opened on the SEO tab: the form is hidden and the panel is mounted', () => {
    const html = tabbed({}, { initialTab: 'seo' });
    expect(html).toMatch(/<form class="editor" novalidate="" hidden="">/i);
    expect(html).toMatch(/data-editor-tab="seo"(?![^>]*hidden)[^>]*><p>THE SEO PANEL<\/p>/);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>SEO</);
  });

  it('a tab holding an error says so: a dot, and words that end its name', () => {
    const html = tabbed(
      {
        status: 'error',
        errors: {
          byId: { 'f-authorId': 'a published post must have an author' },
          summary: [{ id: 'f-authorId', message: 'Author: a published post must have an author' }],
        },
      },
      { initialTab: 'publishing' },
    );
    expect(html).toContain(
      'aria-label="Content, has errors" data-cue="">Content<span class="tab-cue" aria-hidden="true"></span></button>',
    );
    expect(html).toMatch(/data-cue=""[^>]*>Content/);
    expect(html).not.toContain('aria-label="Publishing');
    expect(html).not.toMatch(/>Publishing<span class="tab-cue"/);
    // The summary still links the field, which the reveal listener shows first.
    expect(html).toContain('<a href="#f-authorId">');
  });

  it('read-only: the fields in a disabled fieldset, the note, no Save and no save status', () => {
    const html = tabbed({}, { readOnly: true, readOnlyNote: 'You can read this post.' });
    expect(html).toContain('<fieldset class="editor-ro" disabled="">');
    expect(html).toContain('You can read this post.');
    expect(html).not.toContain('type="submit"');
    expect(html).not.toContain('class="save-status"');
    expect(html).toContain('Version 4');
    // The fieldset wraps every field tab, and closes before the action bar.
    const set = html.slice(
      html.indexOf('<fieldset class="editor-ro"'),
      html.indexOf('</fieldset><div class="toolbar form-actions">'),
    );
    expect(set).toContain('data-editor-tab="content"');
    expect(set).toContain('data-editor-tab="publishing"');
  });

  it('read-only without tabs too (U5 and U6 may use it alone); editable stays unchanged', () => {
    const html = render(fakeSave(), FIELDS, { readOnly: true });
    expect(html).toContain('<fieldset class="editor-ro" disabled="">');
    expect(html).not.toContain('type="submit"');
    expect(render(fakeSave(), FIELDS, { readOnly: false })).toBe(render(fakeSave(), FIELDS));
  });

  it('"Open on site" for a published post, nothing otherwise', () => {
    const html = tabbed({}, { publicHref: blog.publicHref });
    expect(html).toContain(
      '<a class="btn" href="/creative-knowledge/colour" target="_blank" rel="noopener">Open on site</a>',
    );
    const draft = render(fakeSave({ values: { ...values, status: 'draft' } }), blog.fields, {
      publicHref: blog.publicHref,
    });
    expect(draft).not.toContain('Open on site');
  });

  it('"Open on site" reads the post as saved, never unsaved edits (U8 review)', () => {
    const extra = { publicHref: blog.publicHref };
    // Published chosen, not saved yet: the page does not exist.
    const chosen = render(
      fakeSave({ values, saved: { ...values, status: 'draft' }, dirty: true }),
      blog.fields,
      extra,
    );
    expect(chosen).not.toContain('Open on site');
    // A published post's slug edited, not saved: the page is still at the stored slug.
    const renamed = render(
      fakeSave({ values: { ...values, slug: 'colour-two' }, saved: values, dirty: true }),
      blog.fields,
      extra,
    );
    expect(renamed).toContain('href="/creative-knowledge/colour"');
    expect(renamed).not.toContain('href="/creative-knowledge/colour-two"');
    // A new record has no address, whatever its values say.
    expect(render(fakeSave({ values, isNew: true }), blog.fields, extra)).not.toContain(
      'Open on site',
    );
  });

  it('a rich text is told it is read-only (a disabled fieldset does not stop contenteditable)', () => {
    const field = readFileSync('src/components/admin/FormField.tsx', 'utf8');
    expect(field).toContain('const readOnly = useContext(FieldsReadOnly);');
    expect(field).toContain('readOnly={readOnly}');
    const rich = readFileSync('src/components/admin/RichText.tsx', 'utf8');
    expect(rich).toContain('editable: !readOnly');
    expect(rich).toMatch(
      /if \(readOnly\) \{\s*return \(\s*<div className="rich" data-readonly="">\s*<EditorContent/,
    );
    // Still a lazy chunk that imports nothing new from the shared admin code.
    expect(rich.match(/^import (?!type)[^;]+from '(@\/|\.)[^']*';/gm) ?? []).toEqual([]);
  });

  it('Ctrl/⌘+S and a submit never save a read-only form', () => {
    const source = readFileSync('src/components/admin/fields/EditorForm.tsx', 'utf8');
    expect(source).toContain('if (!form || readOnly) return;');
    expect(source).toContain('if (!readOnly) submit();');
  });
});
