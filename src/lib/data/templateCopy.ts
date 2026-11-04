import { supabaseConfigured } from '@/lib/supabase/client';
import {
  caseCopyFrom,
  serviceCopyFrom,
  BUILT_IN_CASE_COPY,
  BUILT_IN_SERVICE_COPY,
  type CaseCopy,
  type ServiceCopy,
} from '@/lib/templates/copy';
import { reportLoadError } from './parse';
import { contentClient } from './source';

// The published shared text of the two template pages (Admin v2 E3, `public.template_copy`):
// anon-readable (it is the words the service pages and the case studies show), tenant-fenced by
// RLS like every public read, through the content seam, so the releases preview lays a pending
// change over it.
//
// Never throws. No row (the words as built), an unconfigured database, a failed read or an
// unreadable key all give the built-in words (key by key, src/lib/templates/copy.ts), and a
// failed read is logged. The template pages must never fail because of their labels.

/** anon's columns (the E3 migration's column grant): the two templates' stored differences. */
export const TEMPLATE_COPY_PUBLIC_COLUMNS = 'service,project';

/** The stored row, or null (no row, no database, a failed read). */
async function readTemplateCopy(): Promise<Record<string, unknown> | null> {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await contentClient()
      .from('template_copy')
      .select(TEMPLATE_COPY_PUBLIC_COLUMNS)
      .maybeSingle();
    if (error) {
      reportLoadError('template_copy', error);
      return null;
    }
    return (data as Record<string, unknown> | null) ?? null;
  } catch (err) {
    reportLoadError('template_copy', err);
    return null;
  }
}

/** The service page template's words (both languages), the built-in ones where none is stored. */
export async function getServiceCopy(): Promise<ServiceCopy> {
  const row = await readTemplateCopy();
  return row ? serviceCopyFrom(row['service']) : BUILT_IN_SERVICE_COPY;
}

/** The project page template's words (both languages), the built-in ones where none is stored. */
export async function getCaseCopy(): Promise<CaseCopy> {
  const row = await readTemplateCopy();
  return row ? caseCopyFrom(row['project']) : BUILT_IN_CASE_COPY;
}
