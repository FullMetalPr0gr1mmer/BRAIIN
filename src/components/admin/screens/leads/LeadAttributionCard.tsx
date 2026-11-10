import { useId } from 'react';
import { attributionRows } from '@/lib/crm/leadView';

// How the visitor found us (Admin v2 C13, crm.md §7.3): the attribution a web form lead
// recorded, which is there only when the visitor allowed analytics cookies. Every lead worker
// sees it (leads.manage): a page path, a host name, campaign tags, a device class and a country,
// none of it in the §3 gated list. The values print exactly as stored, left to right (paths,
// host names and tags are Latin), and never as links: a host is a name, not a place to send a
// colleague.

export default function LeadAttributionCard({ lead }: { lead: Readonly<Record<string, unknown>> }) {
  const id = useId();
  const rows = attributionRows(lead);
  return (
    <section className="card" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="card-title">
        How they found us
      </h2>
      {rows.length === 0 ? (
        <p className="card__sub">
          Nothing was recorded. We record this only when the visitor allows analytics cookies.
        </p>
      ) : (
        <dl className="stat-rows">
          {rows.map(([label, value]) => (
            <div className="stat-row" key={label}>
              <dt>{label}</dt>
              <dd dir="ltr">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
