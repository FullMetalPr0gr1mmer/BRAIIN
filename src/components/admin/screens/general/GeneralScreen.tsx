import { useState } from 'react';
import EditorForm from '@/components/admin/fields/EditorForm';
import { ClockProvider } from '@/components/admin/kit/clock';
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
// Between them the job-applications switch, which saves at once through its own endpoint
// (R3b's `PATCH /api/admin/site-profile/intake`): Admin only in both server layers, so a
// Developer sees it switched off with the reason. The facts the screen cannot change (the
// domain, the languages) are the page's own server-rendered card.

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
        />
        <ApplicationsSwitch
          open={applicationsOpen}
          canChange={canOpenApplications}
          onChanged={(open, version) => {
            setApplicationsOpen(open);
            // The switch moved the identity row's version; the form above keeps its edits.
            profile.adoptVersion(version);
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
