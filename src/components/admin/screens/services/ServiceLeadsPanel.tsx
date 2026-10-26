import EmptyState from '@/components/admin/kit/EmptyState';
import { Badge } from '@/components/admin/kit/StatusBadge';
import { useClock } from '@/components/admin/kit/clock';
import { BADGE_TONES, type BadgeTone } from '@/lib/admin/tones';

// A service's Leads tab (Admin v2 U5, AV-14: "leads caps only; safe columns; no budget"): the
// newest inquiries that named this service, read on the server page for the roles holding
// leads.manage (src/lib/admin/servicesArea.ts loadServiceLeads: the safe columns through the
// caller's own client, so the column grant and the live check decide). The number, the
// person's name and company, the stage and when it arrived; each a link to the lead, whose
// page does the rest (the audited reveal included). Never the budget, the timeline, an e-mail
// or a phone. Plain table markup, server-rendered with the island: no request of its own.

export interface ServiceLeadRow {
  id: string;
  number: number | null;
  name: string;
  company: string | null;
  stage: { label: string; tone: string } | null;
  createdAt: string;
}

/** A stage's tone as a badge's (a fixed palette, 0034); gray for anything else. */
function toneOf(tone: string): BadgeTone {
  return (BADGE_TONES as readonly string[]).includes(tone) ? (tone as BadgeTone) : 'gray';
}

export interface ServiceLeadsPanelProps {
  leads: { rows: ServiceLeadRow[]; more: boolean } | null;
  /** The read failed (logged on the server). */
  failed: boolean;
}

export default function ServiceLeadsPanel({ leads, failed }: ServiceLeadsPanelProps) {
  const { formatDate } = useClock();
  if (failed || !leads) {
    return (
      <p className="msg" data-kind="error" role="alert">
        The leads for this service could not be read. Reload the page to try again.
      </p>
    );
  }
  if (leads.rows.length === 0) {
    return (
      <EmptyState
        icon="inbox"
        title="No leads for this service yet"
        text="Inquiries that name this service show here."
      />
    );
  }
  return (
    <section className="card svc-leads" aria-labelledby="svc-leads-h">
      <h2 className="card-title" id="svc-leads-h">
        Inquiries naming this service
      </h2>
      <div className="table-wrap">
        <table className="data">
          <caption className="visually-hidden">Inquiries naming this service, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Stage</th>
              <th scope="col">Received</th>
            </tr>
          </thead>
          <tbody>
            {leads.rows.map((lead) => (
              <tr key={lead.id}>
                <td>
                  <a className="data-link" href={`/admin/leads/${lead.id}`} dir="auto">
                    {lead.name || `Lead ${lead.number ?? ''}`.trim()}
                  </a>
                  {lead.company && (
                    <div className="cell-secondary" dir="auto">
                      {lead.company}
                    </div>
                  )}
                </td>
                <td>
                  {lead.stage ? (
                    <Badge tone={toneOf(lead.stage.tone)}>{lead.stage.label}</Badge>
                  ) : (
                    <span className="admin-sub">Not set</span>
                  )}
                </td>
                <td>{formatDate(lead.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="admin-sub">
        {leads.more ? 'The newest 20 are shown. ' : ''}
        <a href="/admin/leads">All leads</a>
      </p>
    </section>
  );
}
