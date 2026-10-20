import { useCallback, useEffect, useState } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';
import ResponseCard from './ResponseCard';
import ScoringCard from './ScoringCard';
import StagesCard from './StagesCard';
import type { CrmSettingsAnswer, CrmSettingsRow } from './types';

// /admin/crm/settings (Admin v2 C9a, crm.md §11 screen 11): CRM settings for leads, Admin only
// (`crm.settings`). The server refuses every other role, and the island shows that refusal
// (the U14a pattern). Three cards, each with its own Save (crm.md: "Every card has an
// explicit Save"; P-5: the CRM never autosaves keystrokes): the pipeline stages, lead
// scoring, and response time with assignment. The two settings cards share the row's version:
// a save by one moves it for the other without touching the other's unsaved fields.

const API = '/api/admin/crm/settings';

export default function CrmSettingsScreen() {
  const [data, setData] = useState<CrmSettingsAnswer | null>(null);
  const [version, setVersion] = useState(1);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const answer = await adminFetch<CrmSettingsAnswer>(API);
      setData(answer);
      setVersion(answer.settings.version);
      setLoadError(null);
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, []);

  // After a stage save: the pipeline and its counts again, the settings cards left alone.
  const reloadStages = useCallback(async () => {
    try {
      const answer = await adminFetch<CrmSettingsAnswer>(API);
      setData((current) => (current ? { ...current, stages: answer.stages } : answer));
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError) {
    return (
      <p className="msg" data-kind="error" role="alert">
        {loadError}
      </p>
    );
  }
  if (!data) return <p className="admin-sub">Loading…</p>;

  const saved = (settings: CrmSettingsRow) => setVersion(settings.version);
  return (
    <div className="grid grid--2">
      <StagesCard loaded={data.stages} onSaved={reloadStages} />
      <div className="crm-set__col">
        <ScoringCard settings={data.settings} version={version} onSaved={saved} />
        <ResponseCard
          settings={data.settings}
          version={version}
          people={data.people}
          onSaved={saved}
        />
      </div>
    </div>
  );
}
