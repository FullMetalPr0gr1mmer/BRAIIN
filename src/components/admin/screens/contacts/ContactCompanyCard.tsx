import { useEffect, useId, useRef, useState } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';
import { toast } from '@/lib/admin/toast';
import type { ContactDetailRow } from '@/lib/crm/contactPage';

// A contact's company (Admin v2 C11, crm.md §5.3 and §11 screen 6): the company record the
// contact belongs to, or the way to link one. Linked: its name, "Open in Companies" and
// Unlink. Not linked: "Create company from this name" when the contact has a typed company
// (the company the name folds to is found, or made), and a search of the companies to link
// one (a POST body, never an address; names only). Each change is one request at the
// contact's version, through the page's queue (`change`); the page reads the contact again.
// Linking publishes nothing; while linked, the contact shows the company's name.
// (C11 review, C11-COR-5) A company made from an inquiry goes with its last contact, so the
// card says so beside Unlink, and says so again when an unlink removed one.

export type CompanyChange =
  { action: 'link'; companyId: string } | { action: 'create' } | { action: 'unlink' };

interface Found {
  id: string;
  name: string;
  city: string | null;
}

export interface ContactCompanyCardProps {
  contact: ContactDetailRow;
  busy: boolean;
  /**
   * One change through the page's queue; resolves true when it was saved, 'removed' when it
   * was saved and took the company the contact left with it, false otherwise.
   */
  change: (body: CompanyChange) => Promise<boolean | 'removed'>;
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The toast after a change (C11-COR-5: a removed auto-company is said, never silent). */
export function changeWords(action: CompanyChange['action'], removed: boolean): string {
  const done = action === 'unlink' ? 'Company unlinked.' : 'Company linked.';
  return removed
    ? `${done} The company it left was made from an inquiry and had no other contacts, so it was removed.`
    : done;
}

export default function ContactCompanyCard({ contact, busy, change }: ContactCompanyCardProps) {
  const id = useId();
  const companyId = typeof contact['company_id'] === 'string' ? contact['company_id'] : null;
  const typed = str(contact['company_name']);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Found[] | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);

  // The companies search: two characters or more, 250 ms after the last key, as a POST.
  useEffect(() => {
    const q = query.trim();
    pending.current?.abort();
    if (q.length < 2) {
      setFound(null);
      setStatus('');
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    const timer = window.setTimeout(() => {
      adminFetch<{ rows: { id: string; name: string; city: string | null }[] }>(
        '/api/admin/crm/companies/query',
        { method: 'POST', body: { q, limit: 8 }, signal: controller.signal },
      )
        .then((answer) => {
          if (controller.signal.aborted) return;
          const rows = answer.rows.map((r) => ({ id: r.id, name: r.name, city: r.city ?? null }));
          setFound(rows);
          setStatus(
            rows.length === 0
              ? 'No company matches.'
              : `${rows.length} ${rows.length === 1 ? 'company' : 'companies'} found.`,
          );
          setError('');
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setFound(null);
          setError(describeError(err));
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  async function run(body: CompanyChange) {
    const saved = await change(body);
    if (saved) {
      setQuery('');
      setFound(null);
      toast(changeWords(body.action, saved === 'removed'), 'ok');
    }
  }

  return (
    <section className="card" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="card-title">
        Company
      </h2>
      {companyId ? (
        <>
          <p>
            <strong dir="auto">{typed || 'A company'}</strong>
          </p>
          <p className="ct-channels__a">
            <a href={`/admin/contacts/companies?company=${encodeURIComponent(companyId)}`}>
              Open in Companies
            </a>
            <button
              type="button"
              data-size="sm"
              disabled={busy}
              onClick={() => void run({ action: 'unlink' })}
            >
              Unlink
            </button>
          </p>
          <p className="f__hint">A new name for the company shows here too.</p>
          <p className="f__hint">
            A company made from an inquiry is removed when its last contact is unlinked.
          </p>
        </>
      ) : (
        <>
          {typed ? (
            <>
              <p>
                Typed as <span dir="auto">{typed}</span>, not linked to a company record yet.
              </p>
              <p>
                <button
                  type="button"
                  data-size="sm"
                  disabled={busy}
                  onClick={() => void run({ action: 'create' })}
                >
                  Create company from this name
                </button>
              </p>
            </>
          ) : (
            <p className="f__hint">Not linked to a company.</p>
          )}
          <div className="f">
            <label className="f__l" htmlFor={`${id}-q`}>
              Link to a company
            </label>
            <input
              id={`${id}-q`}
              type="search"
              maxLength={64}
              dir="auto"
              autoComplete="off"
              placeholder="Search by company name"
              value={query}
              aria-describedby={`${id}-status`}
              onChange={(event) => setQuery(event.target.value)}
            />
            <p id={`${id}-status`} className="f__hint" role="status">
              {status}
            </p>
            {error && (
              <p className="msg" data-kind="error" role="alert">
                {error}
              </p>
            )}
          </div>
          {found && found.length > 0 && (
            <ul className="ct-leads" aria-label="Companies found">
              {found.map((company) => (
                <li key={company.id} className="ct-leads__i">
                  <span dir="auto">{company.name}</span>
                  {company.city && (
                    <span className="lead-sub" dir="auto">
                      {company.city}
                    </span>
                  )}
                  <button
                    type="button"
                    data-size="sm"
                    disabled={busy}
                    onClick={() => void run({ action: 'link', companyId: company.id })}
                  >
                    Link <span className="visually-hidden">{company.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
