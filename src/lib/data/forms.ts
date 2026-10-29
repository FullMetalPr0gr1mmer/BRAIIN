import { supabaseConfigured } from '@/lib/supabase/client';
import { BUILT_IN_FORMS, formSettingsFromRow, type FormSettings } from '@/lib/forms/config';
import { reportLoadError } from './parse';
import { contentClient } from './source';

// The published forms config (Admin v2 E8, `public.form_settings`, 0117): anon-readable (it
// is the copy the forms show), tenant-fenced by RLS like every public read, through the
// content seam, so the releases preview lays a pending change over it.
//
// Never throws. No row (the forms as built), an unconfigured database, a failed read or an
// unreadable value all give the built-in forms (src/lib/forms/config.ts reads the row part by
// part), and a failure is logged.

/** The columns anon may read (0117's column grant): the copy and the consent revision. */
export const FORM_SETTINGS_PUBLIC_COLUMNS = 'inquiry,application,consent_revision';

export async function getFormSettings(): Promise<FormSettings> {
  if (!supabaseConfigured()) return BUILT_IN_FORMS;
  try {
    const { data, error } = await contentClient()
      .from('form_settings')
      .select(FORM_SETTINGS_PUBLIC_COLUMNS)
      .maybeSingle();
    if (error) {
      reportLoadError('form_settings', error);
      return BUILT_IN_FORMS;
    }
    return formSettingsFromRow(data);
  } catch (err) {
    reportLoadError('form_settings', err);
    return BUILT_IN_FORMS;
  }
}

type FormLocals = Pick<App.Locals, 'formSettings'>;

/**
 * Once per request: the first form on a page starts the read and every later one awaits the
 * same promise (there is one form per page today; the memo keeps it one read if that changes).
 */
export function formSettingsFor(locals: FormLocals): Promise<FormSettings> {
  locals.formSettings ??= getFormSettings();
  return locals.formSettings;
}
