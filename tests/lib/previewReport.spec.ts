import { describe, expect, it } from 'vitest';
import {
  assessPreview,
  createReport,
  notPreviewedKey,
  PREVIEW_COPY,
  previewLogFields,
  type PreviewReport,
  type UntrustedReason,
} from '@/lib/preview/report';

// The preview's fail-closed verdict and its copy (Admin v2 R8, src/lib/preview/report.ts).

const trusted = (): PreviewReport => ({
  ...createReport(),
  reads: 3,
  tables: { services: 2, pages: 1 },
});

describe('assessPreview', () => {
  it('is ok with reads and nothing wrong, carrying the count, the invalid drafts and what is not previewed', () => {
    const r = trusted();
    r.pending = 4;
    r.invalid.push({ draftId: 'd', entityType: 'service', entityId: 'e', reason: 'invalid' });
    r.notPreviewed.push('rpc:search_content', 'redirect');
    expect(assessPreview(r)).toEqual({
      state: 'ok',
      pending: 4,
      invalid: [{ draftId: 'd', entityType: 'service', entityId: 'e', reason: 'invalid' }],
      notPreviewed: ['rpc:search_content', 'redirect'],
    });
  });

  it.each<[UntrustedReason, (r: PreviewReport) => void]>([
    ['no-reads', (r) => (r.reads = 0)],
    ['anon-lookup', (r) => (r.anonLookups = 1)],
    ['unsupported', (r) => r.unsupported.push('services.neq')],
    ['truncated', (r) => r.truncated.push('media_assets')],
    ['failed-table', (r) => r.failedTables.push('services')],
    ['foreign-tenant', (r) => (r.foreignTenantRows = 1)],
  ])('is untrusted for %s', (reason, spoil) => {
    const r = trusted();
    spoil(r);
    expect(assessPreview(r)).toEqual({ state: 'untrusted', reasons: [reason] });
  });

  it('lists every reason at once', () => {
    const r = createReport();
    r.anonLookups = 2;
    r.truncated.push('categories');
    expect(assessPreview(r)).toEqual({
      state: 'untrusted',
      reasons: ['no-reads', 'anon-lookup', 'truncated'],
    });
  });
});

describe('previewLogFields', () => {
  it('carries counts and names only: no draft id, entity id or value', () => {
    const r = trusted();
    r.invalid.push({
      draftId: '0d000000-0000-4000-8000-000000000001',
      entityType: 'service',
      entityId: '00000000-0000-4000-8000-000000000002',
      reason: 'invalid',
    });
    r.unsupported.push('services.neq');
    const fields = previewLogFields(r);
    expect(fields).toMatchObject({
      reads: 3,
      tables: ['pages', 'services'],
      invalid: 1,
      unsupported: ['services.neq'],
    });
    expect(JSON.stringify(fields)).not.toMatch(/0000-4000/);
  });
});

describe('the copy', () => {
  const strings = (value: unknown): string[] =>
    typeof value === 'string' ? [value] : Object.values(value as object).flatMap(strings);
  const all = strings(PREVIEW_COPY);

  it('names a reason for every untrusted state', () => {
    expect(Object.keys(PREVIEW_COPY.reasons).sort()).toEqual([
      'anon-lookup',
      'failed-table',
      'foreign-tenant',
      'no-reads',
      'truncated',
      'unsupported',
    ]);
  });

  it('has no em or en dash and never spells the brand (P-12)', () => {
    expect(all.length).toBeGreaterThan(10);
    for (const text of all) {
      expect(text).not.toMatch(/[–—]/);
      expect(text).not.toMatch(/brai+n|stati+on/i);
    }
  });

  it('maps every not-previewed name to its line', () => {
    expect(notPreviewedKey('rpc:search_content')).toBe('search');
    expect(notPreviewedKey('rpc:search_suggest')).toBe('search');
    expect(notPreviewedKey('rpc:anything_else')).toBe('rpc');
    expect(notPreviewedKey('redirect')).toBe('redirect');
    expect(notPreviewedKey('custom_theme')).toBe('custom_theme');
    expect(notPreviewedKey('page_visibility')).toBe('page_visibility');
    expect(notPreviewedKey('something')).toBe('rpc');
    expect(PREVIEW_COPY.notPreviewed.search).toBe("Search results aren't previewed.");
  });
});
