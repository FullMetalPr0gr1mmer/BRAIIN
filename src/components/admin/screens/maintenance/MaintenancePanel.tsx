import { useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { timeZoneCity } from '@schemas/timeZones';
import EditorForm from '@/components/admin/fields/EditorForm';
import { ClockProvider, useClock } from '@/components/admin/kit/clock';
import Icon from '@/components/admin/kit/Icon';
import { saveModeFor } from '@/lib/admin/saveMode';
import { maintenanceUi } from '@/lib/admin/ui/maintenance';
import { useEntitySave } from '@/lib/admin/useEntitySave';
import type { FieldDef } from '@/lib/admin/uiSchema';
import MaintenanceSketch from './MaintenanceSketch';
import TurnOnDialog from './TurnOnDialog';

// Maintenance mode (/admin/maintenance, Admin v2 U9b; the prototype's `opsMaintenanceCard`),
// `maintenance.manage` (Admin + Developer). A `useEntitySave` singleton over
// /api/admin/settings/maintenance, drawn by EditorForm:
//
//   - the status banner: on or live, as visitors see it NOW (a "Back on" day that has come
//     ended it), and Turn on (a danger confirmation first) or Turn off. Both save the form as
//     it is with the switch flipped; Save keeps the switch where it is;
//   - the page (headline, message, background, buttons), coming back ("Back on", the date),
//     who still sees the site (the staff bypass, IP addresses), with "What visitors see" and
//     "Preview full screen" (the real page of the saved settings) beside them.
//
// Two things this screen must be honest about, because both are ways to lock yourself out of
// your own site:
//   1. `kvSynced: false`: the setting was stored but the EDGE did not get it. The pre-cache
//      check reads KV, so an unsynced switch is a maintenance window that never started (or
//      never ended). Reported, never swallowed; so is an edge the GET finds out of step.
//   2. With the bypass off, only the allowed addresses see the site: the confirmation says so,
//      and says when that is nobody. /admin stays reachable (it is exempt).

interface RowState {
  effective: { active: boolean; endedByDate: boolean };
  edgeActive: boolean | null;
  kvSynced: boolean | null;
}

const PREVIEW = '/api/admin/settings/maintenance/preview';

function Panel() {
  const clock = useClock();
  const city = timeZoneCity(clock.zone);
  const target = { kind: 'singleton', endpoint: maintenanceUi.endpoint } as const;
  const [row, setRow] = useState<RowState | null>(null);
  const save = useEntitySave(target, null, {
    fields: maintenanceUi.fields,
    mode: saveModeFor(target),
    onRow: (answer) => {
      const effective = answer['effective'] as RowState['effective'] | undefined;
      setRow({
        effective: {
          active: effective?.active === true,
          endedByDate: effective?.endedByDate === true,
        },
        edgeActive: typeof answer['edgeActive'] === 'boolean' ? answer['edgeActive'] : null,
        kvSynced: typeof answer['kvSynced'] === 'boolean' ? answer['kvSynced'] : null,
      });
    },
  });
  const [asking, setAsking] = useState(false);

  // The drawn fields: all but the switch, and "Back on" says whose midnight it is.
  const drawn = useMemo<FieldDef[]>(
    () =>
      maintenanceUi.fields
        .filter((field) => field.name !== 'active')
        .map((field) =>
          field.name === 'until'
            ? {
                ...field,
                help: `Maintenance turns off by itself at midnight that day, ${city} time. Up to 30 days ahead.`,
              }
            : field,
        ),
    [city],
  );

  const on = row?.effective.active === true;
  const bypass = save.values['staffBypass'] === true;
  const allowlist = Array.isArray(save.values['allowlist'])
    ? (save.values['allowlist'] as unknown[])
    : [];

  /** Saves the form as it is with the switch set to `active`. */
  async function flip(active: boolean): Promise<void> {
    const before = save.values['active'];
    flushSync(() => save.set('active', active));
    const saved = await save.save();
    if (!saved) save.set('active', before);
  }

  const edgeOut =
    row !== null && row.edgeActive !== null && row.edgeActive !== row.effective.active;

  return (
    <div>
      <section
        className="mnt-status"
        data-state={on ? 'on' : 'off'}
        aria-labelledby="mnt-status-t"
        aria-live="polite"
      >
        <span className="mnt-status__dot" aria-hidden="true" />
        <div className="mnt-status__text">
          <h2 id="mnt-status-t" className="mnt-status__t">
            {on ? 'Maintenance mode is on' : 'The site is live'}
          </h2>
          <p className="mnt-status__s">
            {on
              ? 'Visitors see the maintenance page. Search engines get a temporary status, so rankings are safe for a few days.'
              : row?.effective.endedByDate
                ? 'Maintenance ended by itself on its Back on day.'
                : 'Turn it on for a big change, a relaunch, or a problem you need to fix.'}
          </p>
        </div>
        {row !== null &&
          (on ? (
            <button
              type="button"
              className="btn"
              disabled={save.busy}
              onClick={() => void flip(false)}
            >
              <Icon name="check" size={16} />
              Turn off
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              data-variant="danger"
              disabled={save.busy}
              onClick={() => setAsking(true)}
            >
              <Icon name="warn" size={16} />
              Turn on
            </button>
          ))}
      </section>

      {row?.kvSynced === false && (
        <p className="msg" data-kind="error" role="alert">
          Saved, but the edge did not pick it up, so visitors still get the site as it was. Save
          again before relying on it.
        </p>
      )}
      {row?.kvSynced !== false && edgeOut && (
        <p className="msg" data-kind="error" role="alert">
          The edge does not match these settings: visitors{' '}
          {row?.edgeActive ? 'see the maintenance page' : 'see the site'}. Save again to put it
          right.
        </p>
      )}

      <div className="grid--3-2 mnt__body">
        <EditorForm
          save={save}
          fields={drawn}
          groups={maintenanceUi.groups}
          submitLabel="Save maintenance settings"
        />
        <aside className="mnt__side" aria-labelledby="mnt-sketch-t">
          <h2 id="mnt-sketch-t" className="mnt__side-t">
            What visitors see
          </h2>
          <MaintenanceSketch values={save.values} />
          <p className="mnt__side-links">
            <a className="btn" href={`${PREVIEW}?lang=en`} target="_blank" rel="noopener">
              <Icon name="eye" size={16} />
              Preview full screen
            </a>
            <a className="btn" href={`${PREVIEW}?lang=ar`} target="_blank" rel="noopener">
              In Arabic
            </a>
          </p>
          <p className="admin-sub">The preview shows the saved settings.</p>
        </aside>
      </div>

      <TurnOnDialog
        open={asking}
        bypass={bypass}
        allowed={allowlist.length}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          void flip(true);
        }}
      />
    </div>
  );
}

export default function MaintenancePanel({ tz }: { tz?: string | undefined }) {
  return (
    <ClockProvider tz={tz}>
      <Panel />
    </ClockProvider>
  );
}
