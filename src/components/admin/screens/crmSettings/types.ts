// What GET /api/admin/crm/settings answers (src/lib/crm/settings.ts readCrmSettings).

export interface StageRow {
  id: string;
  key: string;
  label: string;
  label_ar: string | null;
  tone: string;
  kind: string;
  is_initial: boolean;
  sort_order: number;
  version: number;
  leads: number;
}

export interface CrmSettingsRow {
  version: number;
  scoring: Record<string, number>;
  slaHours: number;
  timezone: string;
  assignment: { rule: string; pool: string[]; fixedTo: string | null };
  updatedAt: string | null;
}

export interface Person {
  id: string;
  display_name: string | null;
  role: string | null;
}

export interface CrmSettingsAnswer {
  settings: CrmSettingsRow;
  stages: StageRow[];
  people: Person[];
}

/** A stage while it is being edited: a new one has no id yet, a local key for React only. */
export interface StageDraft {
  id?: string | undefined;
  local: string;
  label: string;
  tone: string;
  kind: string;
  is_initial: boolean;
  leads: number;
}
