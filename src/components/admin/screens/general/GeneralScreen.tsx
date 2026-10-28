import { useState } from 'react';
import EditorForm from '@/components/admin/fields/EditorForm';
import { ClockProvider } from '@/components/admin/kit/clock';
import { singletonHistory } from '@/lib/admin/historyTarget';
import { saveModeFor } from '@/lib/admin/saveMode';
import { profileUi } from '@/lib/admin/ui/profile';
import { settingsUi } from '@/lib/admin/ui/settings';
import { useEntitySave } from '@/lib/admin/useEntitySave';
import ApplicationsSwitch from './ApplicationsSwitch';
import BrandFacts from './BrandFacts';
import type { GeneralScreenProps } from './types';

// General settings (/admin/settings, Admin v2 U9, AV-18; the prototype's
// `route('/settings/general')`). Two editors, each saved on its own (F5a: Ctrl/⌘+S saves the
// one focus is in):
//
//   - the public identity (`site_profile`, settings.general): Site, Brand and Advanced on the
//     left, Contact and Social accounts on the right. Saving puts it live (staged with the
//     rest of a release once releases switch on, R3: the same endpoint);
//   - Region and data (`site_settings`, settings.general): the studio's time zone and how long
//     data is kept, immediate always (P-3).
//
// The identity's History (Admin v2 R14-prep) lists every save of it that went live, newest
// first, and restores one once releases are on (R13's drawer; the history names the site, not
// an id: historyTarget.ts). Region and data keeps no history (immediate, not a release's).
//
// Between them the job-applications switch, which saves at once through its own endpoint
// (R3b's `PATCH /api/admin/site-profile/intake`): Admin only in both server layers, so a
// Developer sees it switched off with the reason. The facts the screen cannot change (the
// domain, the languages) are the page's own server-rendered card.

/** The identity's history: the site's own (no id), previewed on the home page. */
export const IDENTITY_HISTORY = singletonHistory('site_profile');
export const IDENTITY_HISTORY_OF = { label: 'Site identity', path: '/' } as const;

export default function GeneralScreen({ logoSrc, canOpenApplications, tz }: GeneralScreenProps) {
  const profileTarget = { kind: 'singleton', endpoint: profileUi.endpoint } as const;
  const settingsTarget = { kind: 'singleton', endpoint: settingsUi.endpoint } as const;
  // The switch is on the identity row: what the row said when it was read or saved.
  const [applicationsOpen, setApplicationsOpen] = useState<boolean | null>(null);
  const profile = useEntitySave(profileTarget, null, {
    fields: profileUi.fields,
    mode: saveModeFor(profileTarget),
    onRow: (row) => setApplicationsOpen(row['accepting_applications'] === true),
  });
  const settings = useEntitySave(settingsTarget, null, {
    fields: settingsUi.fields,
    mode: saveModeFor(settingsTarget),
  });

  return (
    <ClockProvider tz={tz}>
      <div className="general">
        <EditorForm
          save={profile}
          fields={profileUi.fields}
          groups={profileUi.groups}
          slots={{ brand: <BrandFacts logoSrc={logoSrc} /> }}
          submitLabel="Save general settings"
          history={IDENTITY_HISTORY}
          historyOf={IDENTITY_HISTORY_OF}
        />
        <ApplicationsSwitch
          open={applicationsOpen}
          canChange={canOpenApplications}
          onChanged={(open, version, changed) => {
            setApplicationsOpen(open);
            // The switch moved the identity row's version; the form above keeps its edits and
            // takes the new version only if nothing but this write moved it (entitySave.ts).
            if (changed) profile.adoptVersion(version);
          }}
        />
        <EditorForm
          save={settings}
          fields={settingsUi.fields}
          groups={settingsUi.groups}
          submitLabel="Save region and data"
        />
      </div>
    </ClockProvider>
  );
}
