import { IMPORT_COLUMNS } from '@schemas/crmImport';
import { defineAdminRoute } from '@/lib/admin/route';
import { toCsv } from '@/lib/admin/csv';

// The import's template (Admin v2 C15): the heading row, nothing else (no sample person who
// could be imported by mistake). Written through toCsv, the exports' writer: every cell
// RFC 4180-quoted with formula injection neutralised, and the BOM Excel needs for Arabic.
// `crm.import`; an attachment, never cached, never sniffed.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'crm.import',
  handler: async () =>
    new Response(toCsv(IMPORT_COLUMNS, []), {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="contacts-import-template.csv"',
        'cache-control': 'private, no-store, max-age=0, must-revalidate',
        'x-content-type-options': 'nosniff',
      },
    }),
});
