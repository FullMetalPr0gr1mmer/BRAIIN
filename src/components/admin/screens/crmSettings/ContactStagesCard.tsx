import { useId } from 'react';
import { CONTACT_STAGE_COPY } from './copy';

// The contact stages card (Admin v2 C9b, crm.md §11 screen 11: "the four, read-only, with the
// mockup's descriptions"). The stages are fixed (the prototype wins over the TDD, verification
// §TDD): they drive the People list's chips and its counts. A contact's stage is changed on
// the contact's page. Nothing here is saved.

export default function ContactStagesCard() {
  const id = useId();
  return (
    <section className="card crm-card" aria-labelledby={`${id}-h`}>
      <h2 className="card-title" id={`${id}-h`}>
        Contact stages
      </h2>
      <p className="admin-sub">Fixed. Change a contact&apos;s stage on their page.</p>
      <dl className="crm-cstages">
        {CONTACT_STAGE_COPY.map(({ stage, label, tone, hint }) => (
          <div className="crm-cstage" key={stage}>
            <dt>
              <span className="badge" data-tone={tone}>
                {label}
              </span>
            </dt>
            <dd className="f__hint">{hint}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
