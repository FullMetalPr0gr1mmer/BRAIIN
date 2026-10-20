import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/lib/admin/errors';
import { postResource } from '@/lib/admin/resources/blog';
import { RESOURCE_UI } from '@/lib/admin/uiSchema';
import ResourceTable, {
  labelled,
  selectLabels,
} from '@/components/admin/screens/resources/ResourceTable';
import { readOnlyNoteFor } from '@/components/admin/screens/resources/ResourceForm';

// Creative Knowledge's server rules (Admin v2 U8b, D11 and D12) and the list's two changes
// (a select column's words, no "New" for a role that cannot create).

const AUTHOR = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const AUTH = { tenantId: TENANT } as never;

/** A client whose team_members read answers `row`, recording what it was asked. */
function fakeSb(row: Record<string, unknown> | null, error: { message: string } | null = null) {
  const asked: string[] = [];
  const query = {
    select: (columns: string) => {
      asked.push(`select ${columns}`);
      return query;
    },
    eq: (column: string, value: string) => {
      asked.push(`${column}=${value}`);
      return query;
    },
    maybeSingle: async () => ({ data: row, error }),
  };
  return {
    asked,
    sb: {
      from: (table: string) => {
        asked.push(`from ${table}`);
        return query;
      },
    } as never,
  };
}

const LIVE = {
  title: { en: 'Colour', ar: 'اللون' },
  author_id: AUTHOR,
  status: 'published',
};

describe('a published post’s author must be a published team member (D11)', () => {
  it('a published author passes, read once through the caller’s client, tenant-scoped', async () => {
    const { sb, asked } = fakeSb({ status: 'published' });
    await expect(
      postResource.assertPublishable!(LIVE, { auth: AUTH, sb }),
    ).resolves.toBeUndefined();
    expect(asked).toEqual([
      'from team_members',
      'select status',
      `tenant_id=${TENANT}`,
      `id=${AUTHOR}`,
    ]);
  });

  it('a draft, archived or unseen author is refused on the author field', async () => {
    for (const row of [{ status: 'draft' }, { status: 'archived' }, null]) {
      const { sb } = fakeSb(row);
      const refusal = postResource.assertPublishable!(LIVE, { auth: AUTH, sb });
      await expect(refusal).rejects.toBeInstanceOf(ValidationError);
      await expect(refusal).rejects.toMatchObject({
        detail: 'the author must be a published team member',
        field: 'authorId',
      });
    }
  });

  it('no author is refused before anything is read; a failed read is an error, not a pass', async () => {
    const none = fakeSb({ status: 'published' });
    await expect(
      postResource.assertPublishable!({ ...LIVE, author_id: null }, { auth: AUTH, sb: none.sb }),
    ).rejects.toMatchObject({ field: 'authorId' });
    expect(none.asked).toEqual([]);
    const broken = fakeSb(null, { message: 'boom' });
    await expect(
      postResource.assertPublishable!(LIVE, { auth: AUTH, sb: broken.sb }),
    ).rejects.toThrow('read team_members: boom');
  });
});

describe('an untouched body keeps the stored article (D12)', () => {
  it('`body: null` writes neither body nor body_html (nor a reading time)', () => {
    const row = postResource.toRow({ slug: 'colour', title: LIVE.title, body: null });
    expect(row).not.toHaveProperty('body');
    expect(row).not.toHaveProperty('body_html');
    expect(row).not.toHaveProperty('reading_minutes');
    expect(row).toMatchObject({ slug: 'colour' });
  });

  it('an emptied editor sends a document, which still clears and re-derives', () => {
    const empty = { en: { type: 'doc', content: [] } };
    const row = postResource.toRow({ slug: 'colour', body: empty });
    expect(row['body']).toEqual(empty);
    expect(row).toHaveProperty('body_html');
  });

  it('a written body is stored with its HTML, as before', () => {
    const body = {
      en: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
      },
    };
    const row = postResource.toRow({ slug: 'colour', body });
    expect(row['body']).toEqual(body);
    expect(String((row['body_html'] as Record<string, string>)['en'])).toContain('Hi');
  });
});

describe('the list (ResourceTable)', () => {
  it('a column that is a select of the form shows the option’s words', () => {
    const ui = RESOURCE_UI['ai-questions']!;
    const column = ui.columns.find((c) => c.key === 'input_type')!;
    const labels = selectLabels(column, ui.fields);
    expect(labelled('single', labels)).toBe('Single choice');
    expect(labelled('scale', labels)).toBe('Scale');
    expect(labelled('hand-edited', labels)).toBe('hand-edited');
    expect(
      selectLabels(
        ui.columns.find((c) => c.key === 'prompt')!,
        ui.fields,
      ),
    ).toBeNull();
    expect(labelled('x', null)).toBe('x');
  });

  it('no "New" for a role that cannot create; there by default', () => {
    const shown = renderToStaticMarkup(createElement(ResourceTable, { resource: 'blog' }));
    expect(shown).toContain('href="/admin/blog/new"');
    expect(shown).toContain('New post');
    const hidden = renderToStaticMarkup(
      createElement(ResourceTable, { resource: 'blog', canCreate: false }),
    );
    expect(hidden).not.toContain('/admin/blog/new');
    expect(hidden).not.toContain('New post');
    expect(hidden).not.toMatch(/\sstyle=/);
  });

  it('a read-only role is told what it may do, plainly', () => {
    expect(readOnlyNoteFor('Post', 'full', true)).toBe(
      'You can read this post. Your role changes its SEO only.',
    );
    expect(readOnlyNoteFor('Post', 'view', true)).toBe(
      'You can read this post. Your role cannot change it.',
    );
  });
});
