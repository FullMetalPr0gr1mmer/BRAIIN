import { useEffect, useState } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';
import { relationParams, type RelationDef } from '@/lib/admin/uiSchema';

// Options for a relation field, loaded from the related resource's own admin API — so
// the list a user can pick from is exactly the rows their role may read (RLS + assertCap
// on that endpoint), never a client-side guess.

export interface Option {
  value: string;
  label: string;
}

const LIMIT = 100; // the API's MAX_PAGE_SIZE

/** A row's display label: a {en, ar} value shows its English, then the slug, then the id. */
export function labelOf(row: Record<string, unknown>, key: string): string {
  const raw = row[key];
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    const text = record['en'] ?? record['ar'];
    if (typeof text === 'string' && text) return text;
  }
  if (typeof raw === 'string' && raw) return raw;
  if (typeof row['slug'] === 'string') return row['slug'];
  return String(row['id'] ?? '');
}

export function useOptions(relation: RelationDef | undefined): {
  options: Option[];
  error: string;
  loading: boolean;
} {
  const [options, setOptions] = useState<Option[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!relation) return;
    const controller = new AbortController();
    const params = relationParams(relation, LIMIT);
    adminFetch<{ rows: Record<string, unknown>[] }>(
      `/api/admin/${relation.resource}?${params.toString()}`,
      { signal: controller.signal },
    )
      .then(({ rows }) =>
        setOptions(
          rows.map((r) => ({ value: String(r['id']), label: labelOf(r, relation.labelKey) })),
        ),
      )
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(describeError(err));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [relation]);

  return { options, error, loading };
}
