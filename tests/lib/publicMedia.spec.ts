import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLIC_MEDIA_COLUMNS } from '@schemas/content';

// Anon reads media_assets and testimonials through COLUMN-level grants (0024, 0021). A
// public loader that selects one column outside the grant gets a permission error, and the
// whole query — every card, every quote — comes back empty. These tests hold the loaders'
// column lists to the grants in the migrations.

const migration = (file: string) =>
  readFileSync(join(process.cwd(), 'supabase', 'migrations', file), 'utf8');

/** The column list of `grant select (a, b, …) on public.<table> to anon`. */
function anonColumns(sql: string, table: string): string[] {
  const match = new RegExp(`grant select \\(([^)]*)\\)\\s+on public\\.${table} to anon`, 'i').exec(
    sql,
  );
  if (!match?.[1]) throw new Error(`no column grant on ${table} to anon`);
  return match[1].split(',').map((c) => c.trim());
}

describe('public column lists stay inside the anon grants', () => {
  it('media_assets (0024)', () => {
    const granted = anonColumns(migration('0024_media_public_read.sql'), 'media_assets');
    for (const column of PUBLIC_MEDIA_COLUMNS.split(',')) expect(granted).toContain(column);
  });

  it('testimonials (0021) — and the consent record is never granted', async () => {
    const granted = anonColumns(migration('0021_sectors_clients_testimonials.sql'), 'testimonials');
    expect(granted).not.toContain('consent_obtained_at');
    expect(granted).not.toContain('consent_reference');
    // The loader's own list (everything before the avatar embed).
    const src = readFileSync(join(process.cwd(), 'src', 'lib', 'data', 'taxonomy.ts'), 'utf8');
    const list = /TESTIMONIAL_COLUMNS =\s*'([^']*)'/.exec(src)?.[1] ?? '';
    const selected = list.split(',').filter((c) => c && !c.includes(':'));
    expect(selected.length).toBeGreaterThan(5);
    for (const column of selected) expect(granted).toContain(column);
    // The embed goes through a granted FK column.
    expect(granted).toContain('avatar_media_id');
  });
});
