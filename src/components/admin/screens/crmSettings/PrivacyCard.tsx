import { useId, useState, type ComponentType } from 'react';
import Icon from '@/components/admin/kit/Icon';
import type { EraseContactDialogProps } from '@/components/admin/screens/contacts/EraseContactDialog';
import { retentionLine } from './copy';
import EraseFinder, { type PickedContact } from './EraseFinder';
import type { PrivacyRow } from './types';

// The Data and privacy card (Admin v2 C9b, crm.md §11 screen 11). It states how long leads and
// contacts are kept after their last activity (site_settings.retention, which General settings
// changes: linked for `settings.general` holders), and, for `crm.erase` holders, starts an
// erasure: find the person (EraseFinder), then C7's erase dialog, loaded with import() on the
// first pick, so neither it nor the contacts' code rides on this screen's first load. The
// flags are UX only: the erasure routes check `crm.erase`, live, before anything is read.
// The prototype's own retention select (2, 3 or 5 years) is not here: retention is General's
// (C9a), at most 24 months (docs/retention.md).

export default function PrivacyCard({ privacy }: { privacy: PrivacyRow }) {
  const id = useId();
  const [finding, setFinding] = useState(false);
  const [picked, setPicked] = useState<PickedContact | null>(null);
  const [Dialog, setDialog] = useState<ComponentType<EraseContactDialogProps> | null>(null);
  const [failed, setFailed] = useState(false);

  function pick(contact: PickedContact) {
    setFinding(false);
    setFailed(false);
    import('@/components/admin/screens/contacts/EraseContactDialog')
      .then((module) => {
        setDialog(() => module.default);
        setPicked(contact);
      })
      .catch(() => setFailed(true));
  }

  return (
    <section className="card crm-card" aria-labelledby={`${id}-h`}>
      <h2 className="card-title" id={`${id}-h`}>
        Data and privacy
      </h2>
      <p>{retentionLine(privacy.retentionMonths)}</p>
      {privacy.canEditRetention && (
        <p className="f__hint">
          <a href="/admin/settings" className="crm-link">
            Change it in General settings
          </a>
        </p>
      )}
      {privacy.canErase && (
        <div className="form-actions">
          <button
            type="button"
            className="btn"
            data-variant="danger"
            onClick={() => setFinding(true)}
          >
            <Icon name="trash" size={16} />
            Erase a person&apos;s data
          </button>
        </div>
      )}
      {failed && (
        <p className="msg" data-kind="error" role="alert">
          This could not be loaded. Reload the page and try again.
        </p>
      )}
      <p className="f__hint">
        A person can ask what you hold about them, or ask for it to be erased. Answer within 30
        days.
      </p>
      {privacy.canErase && (
        <EraseFinder open={finding} onClose={() => setFinding(false)} onPick={pick} />
      )}
      {Dialog && picked && (
        <Dialog open onClose={() => setPicked(null)} contactId={picked.id} name={picked.name} />
      )}
    </section>
  );
}
