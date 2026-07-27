import { defineAdminRoute } from '@/lib/admin/route';
import { writeAudit } from '@/lib/admin/audit';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { assertPrivilegedOpAllowed, recordPrivilegedOp } from '@/lib/admin/rateLimit';
import { writeSystemLog } from '@/lib/data/systemLog';
import { AuthorizationError } from '@/lib/authz/errors';

// Content backup export — `export.backup` (Admin + Developer). Same seven-step lockdown
// as the CSV export (see leads/export.ts), applied to content rather than leads.
//
// ── What this deliberately does NOT contain ──────────────────────────────────────
// No leads, in any form. Not even ciphertext. A "backup" that quietly includes the lead
// table would let `export.backup` stand in for `export.csv` and route around the PII
// gate entirely — and the two capabilities are listed separately in §5 precisely
// because they are different decisions. Database-level backup with PII is the DR path
// (§10: pg_dump → object-locked R2), which runs off-platform under different custody.

export const prerender = false;

/** Content only. Every table here is publishable material, not personal data. */
const BACKUP_TABLES: readonly { table: string; columns: string }[] = [
  {
    table: 'services',
    columns:
      'id,slug,title,blurb,body,hero_video_uid,category,status,is_teaser,sort_order,updated_at',
  },
  {
    table: 'blog_posts',
    columns:
      'id,slug,title,excerpt,body,author_id,category_id,cover_image_url,status,published_at,updated_at',
  },
  { table: 'portfolio', columns: 'id,slug,title,summary,body,status,sort_order,updated_at' },
  { table: 'pages', columns: 'id,slug,title,status,nav_visible,updated_at' },
  {
    table: 'page_sections',
    columns: 'id,page_id,type,content,style,visible,sort_order,updated_at',
  },
  { table: 'navigation', columns: 'id,location,parent_id,label,href,visible,sort_order' },
  { table: 'categories', columns: 'id,slug,name' },
  { table: 'team_members', columns: 'id,slug,name,bio,avatar_url,status,sort_order' },
  { table: 'certifications', columns: 'id,slug,name,issuer,year,logo_url,status,sort_order' },
  { table: 'statistics', columns: 'id,slug,label,value,status,sort_order' },
  { table: 'partner_logos', columns: 'id,name,logo_url,scale,offset_y,visible,sort_order' },
  { table: 'redirects', columns: 'id,source_path,target_path,status' },
  {
    table: 'entity_seo',
    columns:
      'id,entity_type,entity_id,meta_title,meta_description,og_image,canonical_override,robots,schema_type',
  },
  { table: 'media_assets', columns: 'id,kind,storage_path,folder,alt,tags,width,height,mime_type' },
  {
    table: 'ai_questions',
    columns: 'id,slug,prompt,help_text,input_type,options,status,sort_order',
  },
  { table: 'ai_styles', columns: 'id,slug,name,description,traits,image_url,status,sort_order' },
];

const MAX_ROWS_PER_TABLE = 5000;

export const GET = defineAdminRoute({
  cap: 'export.backup',
  handler: async ({ auth, sb }) => {
    await liveRecheck(auth);
    await assertPrivilegedOpAllowed(auth, 'export-backup');
    await recordPrivilegedOp(auth, 'export-backup');

    const attemptLogged = await writeAudit(sb, auth, {
      action: 'export.backup.attempt',
      detail: { tables: BACKUP_TABLES.length },
    });
    if (!attemptLogged) {
      throw new AuthorizationError('export.backup', 'audit unavailable — export refused');
    }

    const payload: Record<string, unknown[]> = {};
    const counts: Record<string, number> = {};
    const failed: string[] = [];

    for (const { table, columns } of BACKUP_TABLES) {
      // Every read goes through the RLS-bound client and repeats the tenant predicate.
      // A backup is the operation most likely to be written with the service-role client
      // "because it needs everything" — which is how a backup becomes a cross-tenant
      // read in a tenant-ready schema.
      const { data, error } = await sb
        .from(table)
        .select(columns)
        .eq('tenant_id', auth.tenantId)
        .limit(MAX_ROWS_PER_TABLE);
      if (error) {
        failed.push(table);
        continue;
      }
      payload[table] = data ?? [];
      counts[table] = data?.length ?? 0;
    }

    const totalRows = Object.values(counts).reduce((sum, n) => sum + n, 0);

    await writeAudit(sb, auth, {
      action: 'export.backup.outcome',
      detail: { status: failed.length ? 'partial' : 'ok', rows: totalRows, counts, failed },
    });

    if (failed.length > 0) {
      void writeSystemLog({
        level: 'warn',
        source: 'admin:export-backup',
        message: `backup export skipped ${failed.length} table(s)`,
        detail: { failed, actorId: auth.userId },
      });
    }

    const filename = `braiin-content-${new Date().toISOString().slice(0, 10)}.json`;
    return new Response(
      JSON.stringify(
        { exportedAt: new Date().toISOString(), tenantId: auth.tenantId, counts, data: payload },
        null,
        2,
      ),
      {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`,
          'cache-control': 'private, no-store, max-age=0, must-revalidate',
        },
      },
    );
  },
});
