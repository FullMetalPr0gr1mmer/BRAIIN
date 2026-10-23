import type { CompareResult } from '@schemas/release';

// Compare in the publish dialog (Admin v2 R12; releases.md §7 "Conflicts": field, live, yours,
// English and Arabic): what GET /api/admin/drafts/[id]/compare answers, as a table. The
// editor draws the same table from its own copy (fields/DraftNotice.tsx), so neither the field
// kit nor the savebar's chunk loads the other.

function Side({ value, kind }: { value: unknown; kind: 'text' | 'bilingual' | 'changed' }) {
  if (kind === 'changed') return <em>changed</em>;
  if (kind === 'bilingual') {
    const pair = (value ?? {}) as Record<string, unknown>;
    const en = typeof pair['en'] === 'string' ? pair['en'] : '';
    const ar = typeof pair['ar'] === 'string' ? pair['ar'] : '';
    return (
      <>
        <span className="cmp__en" dir="auto">
          {en || <em>none</em>}
        </span>
        <span className="cmp__ar" lang="ar" dir="rtl">
          {ar || <em>none</em>}
        </span>
      </>
    );
  }
  return value === null || value === undefined || value === '' ? (
    <em>none</em>
  ) : (
    <span dir="auto">{String(value)}</span>
  );
}

export function CompareRows({ result }: { result: CompareResult }) {
  if (result.removed) return <p>This item was removed on the live site. Discard the change.</p>;
  if (result.columns.length === 0) return <p className="admin-sub">Nothing differs now.</p>;
  return (
    <div className="table-wrap cmp" role="region" aria-label="Live and yours" tabIndex={0}>
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Live now</th>
            <th scope="col">Yours</th>
          </tr>
        </thead>
        <tbody>
          {result.columns.map((row) => (
            <tr key={row.column}>
              <th scope="row">{row.label}</th>
              <td>
                <Side value={row.live} kind={row.kind} />
              </td>
              <td>
                <Side value={row.yours} kind={row.kind} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
