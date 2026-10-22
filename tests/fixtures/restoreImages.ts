import type { ReleaseEntityType } from '@schemas/release';
import { RELEASE_REGISTRY } from '@/lib/release/registry';
import { samplesFor } from './resourceSamples';

// A full change of each release-managed type (every payload key its editor knows, never a
// schedule), from the shared samples (tests/fixtures/resourceSamples.ts), for the R10 specs
// that turn stored images back into changes (tests/lib/releaseRowPayload.spec.ts) and count
// what restoring every type costs (tests/lib/releaseVersions.spec.ts). Made-up content only.

type Row = Record<string, unknown>;

const BI = (en: string, ar: string) => ({ en, ar });
const PAGE = '0f0f0f0f-0000-4000-8000-00000000000a';

/** Values that make one type's full sample pass its schema (the fixture's are plain values). */
const OVERRIDES: Partial<Record<ReleaseEntityType, Row>> = {
  service: { valuePoints: [{ title: BI('Point', 'نقطة'), text: BI('Why', 'لماذا') }] },
  portfolio: { keywords: [BI('Brand', 'هوية')] },
  service_case: {
    problems: [{ problem: BI('Problem', 'مشكلة'), solution: BI('Solution', 'حل') }],
  },
  page_section: { type: 'cta', content: { heading: BI('Heading', 'عنوان') } },
  page_visibility: {
    target: { pageId: PAGE },
    mode: 'hidden',
    redirectPageId: null,
    hideFrom: '2026-11-02',
    showOn: '2026-11-09',
  },
};

/** The sample payload of one type: every key it knows, never a schedule. */
export function fullPayload(type: ReleaseEntityType): Row {
  const entry = RELEASE_REGISTRY[type];
  const samples = samplesFor(type);
  const out: Row = {};
  for (const key of [...Object.keys(entry.fields), ...entry.childKeys]) {
    if (key === 'scheduledFor' || !(key in samples)) continue;
    out[key] = samples[key];
  }
  return { ...out, ...(OVERRIDES[type] ?? {}) };
}

/** The ids the samples link to (a picture, a discipline, a page …): one row of each, per table. */
export const SAMPLE_LINKED_IDS = [
  '0f0f0f0f-0000-4000-8000-00000000000a',
  '0f0f0f0f-0000-4000-8000-00000000000b',
  '0f0f0f0f-0000-4000-8000-00000000000c',
] as const;
