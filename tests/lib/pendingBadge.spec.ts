import { readFileSync } from 'node:fs';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PendingBadge, { PENDING_WORDS, pendingKindOf } from '@/components/admin/kit/PendingBadge';
import CollectionList from '@/components/admin/screens/collection/CollectionList';
import { COLLECTIONS } from '@/components/admin/screens/collection/collections';

// The pending-change badge (Admin v2 R12; releases.md §7 "Per-item badges"): a row the release
// path read (releases on) carries `draft`; a live row never does, so with releases off no list
// draws one.

const DRAFT = {
  id: '77777777-7777-4777-8777-000000000001',
  version: 1,
  op: 'update',
  fields: ['question'],
  releaseId: null,
};

describe('which badge a row wears', () => {
  it('none for a live row (releases off), or a row with nothing pending', () => {
    expect(pendingKindOf({ id: 'x', status: 'published' })).toBeNull();
    expect(pendingKindOf({ id: 'x', draft: null })).toBeNull();
  });

  it('the pending change’s kind', () => {
    expect(pendingKindOf({ draft: DRAFT })).toBe('changed');
    expect(pendingKindOf({ draft: { ...DRAFT, op: 'create' } })).toBe('new');
    expect(pendingKindOf({ draft: { ...DRAFT, op: 'delete' }, pendingRemoval: true })).toBe(
      'removal',
    );
    expect(pendingKindOf({ draft: { ...DRAFT, releaseId: DRAFT.id } })).toBe('scheduled');
    expect(pendingKindOf({ draft: { ...DRAFT, conflict: ['question'] } })).toBe('conflict');
    expect(pendingKindOf({ draft: { ...DRAFT, liveMissing: true } })).toBe('conflict');
  });

  it('says it in words (never a colour alone), with no dash (P-12)', () => {
    const html = renderToStaticMarkup(createElement(PendingBadge, { kind: 'removal' }));
    expect(html).toBe('<span class="badge badge--pending" data-tone="err">Will be removed</span>');
    for (const words of Object.values(PENDING_WORDS)) expect(words).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('the lists draw it', () => {
  const list = (rows: Record<string, unknown>[]) =>
    renderToStaticMarkup(
      createElement(CollectionList, {
        def: COLLECTIONS['faq']!,
        rows: rows as never,
        permissions: { write: true, archive: true } as never,
        sortable: false,
        current: null,
        working: false,
        listRef: createRef<HTMLUListElement>(),
        onCommit: () => undefined,
        onOpen: () => undefined,
        onDuplicate: () => undefined,
        onLinkClick: () => undefined,
      }),
    );
  const row = { id: 'a', question: { en: 'How long?', ar: 'كم؟' }, status: 'published' };

  it('a collection row with a pending change wears it; a live one does not', () => {
    expect(list([row])).not.toContain('badge--pending');
    expect(list([{ ...row, draft: DRAFT }])).toContain('Unpublished changes');
  });

  it('the kernel list reads it from the row the release path answers', () => {
    const source = readFileSync('src/components/admin/screens/resources/ResourceTable.tsx', 'utf8');
    expect(source).toContain('const pending = pendingKindOf(row);');
    expect(source).toContain('{pending && (');
  });
});
