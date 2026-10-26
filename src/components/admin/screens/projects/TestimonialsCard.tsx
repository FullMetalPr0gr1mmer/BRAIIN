import { useEffect, useState } from 'react';
import Icon from '@/components/admin/kit/Icon';
import StatusBadge, { Badge } from '@/components/admin/kit/StatusBadge';
import { adminFetch, describeError } from '@/lib/admin/client';

// The testimonial on the project page (Admin v2 U6, AV-15): the prototype wrote the quote into
// the project; here a quote is a testimonial linked to the project (deviations.md §6.2
// projects: "Inline quote -> linked testimonial with consent", the §8 consent gate), so this
// card shows the quotes linked to it, each with where its consent stands (Sample, Needs
// consent, Consent recorded) and its status, and links to it. "Add a quote" opens the
// testimonial drawer with this project already chosen; the quote, its author and the consent
// record are written there, where the consent CHECK applies. The roles that write projects
// write testimonials (portfolio.write), so the card is theirs; the routes check again.

type Row = Record<string, unknown> & { id: string };

interface ListResponse {
  rows: Row[];
}

const text = (value: unknown): string => {
  if (!value || typeof value !== 'object') return '';
  const en = (value as Record<string, unknown>)['en'];
  return typeof en === 'string' ? en.trim() : '';
};

/** Where a quote's consent stands, in words and a tone. */
export function consentState(row: Readonly<Record<string, unknown>>): {
  label: string;
  tone: 'warn' | 'ok' | 'gray';
} {
  if (row['is_placeholder'] === true) return { label: 'Sample', tone: 'gray' };
  return row['consent_obtained_at']
    ? { label: 'Consent recorded', tone: 'ok' }
    : { label: 'Needs consent', tone: 'warn' };
}

export default function TestimonialsCard({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    adminFetch<ListResponse>(
      `/api/admin/testimonials?limit=20&portfolio_id=${encodeURIComponent(projectId)}`,
      { signal: controller.signal },
    )
      .then((data) => setRows(data.rows ?? []))
      .catch((err) => {
        if (!controller.signal.aborted) setError(describeError(err));
      });
    return () => controller.abort();
  }, [projectId]);

  return (
    <section className="card prj-quotes" aria-labelledby="prj-quotes-h">
      <h2 className="card-title" id="prj-quotes-h">
        Testimonial on the project page
      </h2>
      <p className="admin-sub">
        A quote shows on the site once it is published with its consent recorded.
      </p>
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      {rows === null && !error && <p className="admin-sub">Loading…</p>}
      {rows !== null && rows.length === 0 && (
        <p className="admin-sub">No quote is linked to this project yet.</p>
      )}
      {rows !== null && rows.length > 0 && (
        <ul className="list prj-quotes__list">
          {rows.map((row) => {
            const quote = text(row['quote']);
            const author = text(row['author_name']);
            const consent = consentState(row);
            return (
              <li className="li" key={row.id}>
                <div className="li__main">
                  <a className="li__t" href={`/admin/testimonials/${row.id}`} dir="auto">
                    {author || 'A quote'}
                  </a>
                  <span className="li__s" dir="auto">
                    {quote.length > 120 ? `${quote.slice(0, 117)}…` : quote}
                  </span>
                </div>
                <Badge tone={consent.tone}>{consent.label}</Badge>
                {row['status'] !== 'published' && (
                  <StatusBadge status={String(row['status'] ?? 'draft')} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <a className="btn prj-quotes__add" href={`/admin/testimonials/new?project=${projectId}`}>
        <Icon name="plus" size={14} />
        Add a quote
      </a>
    </section>
  );
}
