import { ThemeSettingsSchema, ThemeUpdateSchema, ThemeWriteSchema } from '@schemas/theme';
import { compileTheme } from '@theme/compile';
import { ValidationError } from '../errors';
import type { ResourceConfig } from '../resource';
import { fieldsOf, pick, type Input } from './shared';

// The site's theme (Admin v2 E4, AV-27; Admin + Developer, theme.edit). One v1 theme per tenant
// (custom_themes_one_theme_v1): the editor at /admin/appearance/theme saves its settings, and
// the TOKENS are compiled here from them on every save, staged or live, so a client never
// writes a token and a release's publish (R6, which re-derives each item through this toRow)
// compiles the same way. The settings are contrast-gated by their schema; the database's CHECK
// (custom_themes_theme_v1) holds the tokens to them again.

const THEME_KEYS = { name: 'name', isActive: 'is_active' };

export const themeResource: ResourceConfig = {
  table: 'custom_themes',
  entity: 'custom_theme',
  writeCap: 'theme.edit',
  listColumns: 'id,name,is_active,version,updated_at',
  columns: 'id,name,settings,tokens,is_active,version,created_at,updated_at',
  orderBy: { column: 'name', ascending: true },
  searchColumn: 'name',
  createSchema: ThemeWriteSchema,
  updateSchema: ThemeUpdateSchema,
  // The database's two refusals, said on the settings (a 422, not a stray field name): a
  // second theme created beside the tenant's one (two people saving the first theme at once),
  // and the CHECK, which only a theme the gate let through but the database did not could
  // reach (the same pairs, in SQL: tests/lib/themeSql.spec.ts).
  constraintFields: {
    custom_themes_one_theme_v1: {
      field: 'settings',
      message: 'The site already has a theme. Reload the page to edit it.',
    },
    custom_themes_theme_v1: {
      field: 'settings',
      message: 'These colours are hard to read, so the theme was not saved.',
    },
  },
  toRow: (input) => {
    const row = pick(input as Input, THEME_KEYS);
    const raw = (input as Input)['settings'];
    if (raw !== undefined) {
      // Every route parses the settings first; a value that is not a theme anyway (a payload
      // that skipped the schema) is refused here, never compiled into a 500 or written.
      const settings = ThemeSettingsSchema.safeParse(raw);
      if (!settings.success) throw new ValidationError('not a theme', 'settings');
      row['settings'] = settings.data;
      row['tokens'] = compileTheme(settings.data);
    }
    return row;
  },
  // `settings` writes two columns: itself and the tokens compiled from it.
  fields: fieldsOf(THEME_KEYS, { settings: ['settings', 'tokens'] }),
  // Activating one theme deactivates the others in `afterWrite` (other rows, no column of
  // this patch). With releases on, apply_release does the same in its transaction (0051).
  afterWrite: async ({ auth, sb, row, input }) => {
    if (input['isActive'] !== true) return;
    // Exactly one active theme. Done after the write rather than in a transaction
    // because PostgREST has no multi-statement transaction — the window where two
    // themes are briefly active resolves to "the newly-activated one wins", which is
    // the intent either way.
    await sb
      .from('custom_themes')
      .update({ is_active: false })
      .eq('tenant_id', auth.tenantId)
      .neq('id', String(row['id']));
  },
};
