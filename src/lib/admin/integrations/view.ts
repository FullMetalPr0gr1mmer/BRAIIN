import type { IntegrationsRow } from '@schemas/integrations';

// The Integrations screen's values (Admin v2 U11), from the row the server read or GET's
// answer: pure, so the island takes it without the server read's module.

/** What the screen shows: each value, or null when it is not set up. */
export interface IntegrationsView {
  ga4MeasurementId: string | null;
  searchConsoleToken: string | null;
  calendlyUrl: string | null;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** A row (or GET's answer) → the screen's values. */
export function integrationsView(
  row: Partial<IntegrationsRow> | null | undefined,
): IntegrationsView {
  return {
    ga4MeasurementId: text(row?.ga4_measurement_id),
    searchConsoleToken: text(row?.search_console_token),
    calendlyUrl: text(row?.calendly_url),
  };
}
