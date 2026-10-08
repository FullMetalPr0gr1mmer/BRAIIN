import { ThemeUpdateSchema, ThemeWriteSchema } from '@schemas/admin';
import type { ResourceConfig } from '../resource';
import { pick, type Input } from './shared';

// Themes (Admin + Developer).

export const themeResource: ResourceConfig = {
  table: 'custom_themes',
  entity: 'custom_theme',
  writeCap: 'theme.edit',
  listColumns: 'id,name,is_active,version,updated_at',
  columns: 'id,name,tokens,is_active,version,created_at,updated_at',
  orderBy: { column: 'name', ascending: true },
  searchColumn: 'name',
  createSchema: ThemeWriteSchema,
  updateSchema: ThemeUpdateSchema,
  toRow: (input) => pick(input as Input, { name: 'name', tokens: 'tokens', isActive: 'is_active' }),
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
