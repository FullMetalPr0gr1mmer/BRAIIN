import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EntitySave } from '@/lib/admin/useEntitySave';

// The Forms editor (Admin v2 E8, screens/forms/FormsScreen.tsx) rendered on the server with a
// loaded save: what the editor says beside the fields it edits. The model is
// tests/lib/formsEditor.spec.ts.

vi.mock('@/components/admin/RichText', () => ({ default: () => null }));
vi.mock('@/lib/admin/useEntitySave', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useEntitySave: (): EntitySave => {
    const values = { inquiry: '{}', application: '{}' };
    return {
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
    } as unknown as EntitySave;
  },
}));

const { default: FormsScreen } = await import('@/components/admin/screens/forms/FormsScreen');
const { editorPropsFor } = await import('@/lib/admin/forms/editorProps');

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(FormsScreen, props as never));

describe('the Forms editor', () => {
  it('names a page whose own button text wins over this one there (CR3)', () => {
    const html = render({
      ...editorPropsFor('inquiry'),
      pageButtons: [{ page: 'Contact', en: 'Send it', ar: 'أرسلها' }],
    });
    expect(html).toContain('data-page-button');
    expect(html).toContain(
      'The Contact page sets its own button text in Pages (Send it), and shows it there instead of this one.',
    );
    expect(render(editorPropsFor('inquiry'))).not.toContain('data-page-button');
  });

  it('a consent line is one paragraph, and its textarea says so (CR4)', () => {
    const html = render(editorPropsFor('join'));
    const areas = [...html.matchAll(/<textarea[^>]*>/g)].map((m) => m[0]);
    // English and Arabic, for each of the two consent lines.
    expect(areas).toHaveLength(4);
    for (const area of areas) {
      const hint = /aria-describedby="([^"]+)"/.exec(area)?.[1];
      expect(hint, area).toBeTruthy();
      const note = new RegExp(`<p class="f__cue" id="${hint}">([^<]*)</p>`).exec(html);
      expect(note?.[1]).toContain('One paragraph, without line breaks');
    }
  });
});
