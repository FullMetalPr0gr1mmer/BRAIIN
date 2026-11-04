import { TemplateCopyWriteSchema } from '@schemas/templateCopy';
import type { SingletonConfig } from '@/lib/admin/singleton';
import { fieldsOf } from '@/lib/admin/resources/shared';

// The template pages' shared text (Admin v2 E3, `public.template_copy`, the E3 migration): the
// words every service page and every case study shows around the item's own content, stored as
// what differs from the built-in words, one map per template. §5 "Pages & sections": Admin +
// Content Creator (`pages.write`); a content area, so publishing it once releases are on also
// needs `content.publish` (P-2). Staged (P-3): with releases on the singleton kernel stages a
// save and with releases off it writes live, as every staged editor does today.
//
// A save names one template or both; each one it names replaces that template's stored map
// whole (the editor always sends the whole map it shows). The keys are a closed catalogue per
// template (packages/schemas/templateCopy.ts) and a SQL CHECK holds them again.

/** Payload key → column: what `toRow` copies, and (through `fieldsOf`) its `fields`. */
const TEMPLATE_COPY_COLUMNS = {
  service: 'service',
  project: 'project',
};

export const templateCopySingleton: SingletonConfig = {
  table: 'template_copy',
  entity: 'template_copy',
  // Read by the holders of pages.write only (the template editors); the public site reads it
  // through anon's grant.
  readCaps: ['pages.write'],
  readAccess: ['full'],
  writeCap: 'pages.write',
  columns: 'tenant_id,service,project,version,updated_at',
  schema: TemplateCopyWriteSchema,
  // Both templates as built: what GET answers before the first save.
  defaults: { service: {}, project: {} },
  toRow: (input) => {
    const out: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(TEMPLATE_COPY_COLUMNS)) {
      if (input[key] !== undefined) out[column] = input[key];
    }
    return out;
  },
  fields: fieldsOf(TEMPLATE_COPY_COLUMNS),
  // The CHECKs (the E3 migration): a map that got past the schema is a 422 on its template.
  constraintFields: {
    template_copy_service: {
      field: 'service',
      message:
        'Write each line in English and Arabic, in plain words without < or > or line breaks.',
    },
    template_copy_project: {
      field: 'project',
      message:
        'Write each line in English and Arabic, in plain words without < or > or line breaks.',
    },
  },
};
