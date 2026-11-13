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
  assignment: { rule: string; pool: string[]; fixedTo: string | null };
  /** (C9b) The custom contact fields, in order. */
  customFields: CustomField[];
  updatedAt: string | null;
}

/** (C9b) A custom contact field as crm_settings.custom_fields holds it. */
export interface CustomField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date';
}

/** (C9b) What the Data and privacy card states, and what the viewer may do there (UX only). */
export interface PrivacyRow {
  retentionMonths: number | null;
  canErase: boolean;
  canEditRetention: boolean;
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
  privacy: PrivacyRow;
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
