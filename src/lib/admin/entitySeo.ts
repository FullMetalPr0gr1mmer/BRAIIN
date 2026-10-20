import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { EntitySeoFieldsSchema, seoPairGap, seoPairIssues } from '@schemas/admin';
import type { AuthContext } from '@/lib/auth/types';
import { canonicalPath } from '@/lib/seo/canonical';
import { entityPath, type SeoEntityType } from '@/lib/seo/entityPaths';
import { constraintOf, type ConstraintFields } from './crud';
import { OptimisticLockError, ValidationError } from './errors';

// Per-entity SEO metadata (`seo.entityMeta` — Admin + SEO write, Content Creator view):
// the table, its columns, the request shapes and the payload → column mapping the
// /api/admin/entity-seo route uses, moved out of the route file (Admin v2 R2) so the
// release registry can bind them without importing a route. What the route writes is held
// by tests/lib/releaseOffWrites.spec.ts.
//
// The row is keyed by its target, (entity_type, entity_id), not by its own id: the caller
// always knows what it is editing the meta for. The write is a full replace (PUT): every
// optional column the payload leaves out is written as null.
//
// Admin v2 U10 (0073): the share image from the media library (`og_media_id`), the pair
// rule (a title or description may be left to the page's default; one written needs both
// languages), closed robots values, a canonical override that is a site path (equal to the
// page's own path it is stored as null), and the SEO screen's list (`listEntitySeo`, below;
// every read of the screen lives here, so the release overlay can wrap it).

const COLUMNS =
  'id,entity_type,entity_id,meta_title,meta_description,og_image,og_media_id,canonical_override,robots,schema_type,version,updated_at';

export const SEO_ENTITY_TYPES = ['service', 'blog_post', 'portfolio', 'page'] as const;

const LookupSchema = z.object({
  entityType: z.enum(SEO_ENTITY_TYPES),
  entityId: z.string().uuid(),
});

const WriteSchema = EntitySeoFieldsSchema.extend({ version: z.number().int().min(0) }).superRefine(
  seoPairIssues,
);

const DEFAULTS = {
  meta_title: {},
  meta_description: {},
  og_image: null,
  og_media_id: null,
  canonical_override: null,
  robots: null,
  schema_type: null,
  version: 0,
};

/** Payload key → column for the meta itself (every save writes all seven). */
const META_KEYS = {
  metaTitle: 'meta_title',
  metaDescription: 'meta_description',
  ogImage: 'og_image',
  ogMediaId: 'og_media_id',
  canonicalOverride: 'canonical_override',
  robots: 'robots',
  schemaType: 'schema_type',
} as const;

/** Payload key → column for the target, set once when the row is created. */
const TARGET_KEYS = { entityType: 'entity_type', entityId: 'entity_id' } as const;

type WriteInput = z.infer<typeof WriteSchema>;
type Pair = { en?: string | undefined; ar?: string | undefined } | null | undefined;

/** A pair as stored: `{}` when both halves are blank (the page's default), else both, trimmed. */
function pairToColumn(pair: Pair): Record<string, string> {
  const en = pair?.en?.trim() ?? '';
  const ar = pair?.ar?.trim() ?? '';
  return en || ar ? { en, ar } : {};
}

const blank = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === '' ||
  (typeof value === 'object' && Object.keys(value as object).length === 0);

export const ENTITY_SEO = {
  table: 'entity_seo',
  entity: 'entity_seo',
  writeCap: 'seo.entityMeta',
  COLUMNS,
  LookupSchema,
  WriteSchema,
  DEFAULTS,
  /** The meta columns of a save (a full replace: an optional field left out is null). */
  toRow: (input: Pick<WriteInput, keyof typeof META_KEYS>) => ({
    meta_title: pairToColumn(input.metaTitle),
    meta_description: pairToColumn(input.metaDescription),
    og_image: input.ogImage || null,
    og_media_id: input.ogMediaId ?? null,
    canonical_override: input.canonicalOverride || null,
    robots: input.robots ?? null,
    schema_type: input.schemaType ?? null,
  }),
  /** The target columns, written only on the insert. */
  target: (input: Pick<WriteInput, keyof typeof TARGET_KEYS>) => ({
    entity_type: input.entityType,
    entity_id: input.entityId,
  }),
  /** The payload keys that name the target: fixed once the row exists. */
  targetKeys: Object.keys(TARGET_KEYS) as readonly string[],
  /** Payload key → the column it writes (the target's two only on create). */
  fields: Object.fromEntries(
    Object.entries({ ...META_KEYS, ...TARGET_KEYS }).map(([key, column]) => [key, [column]]),
  ) as Readonly<Record<string, readonly string[]>>,
  /**
   * The pair rule (U10 D4), restated as a domain check because CI blocks an empty
   * `meta_*_ar` (Pillar 3) and the editor should be told which half is missing: each of the
   * title and the description may be left blank (the page's default), but one written needs
   * both languages. The name is R3b's (the staged path calls it too).
   */
  assertBilingual: (input: { metaTitle?: Pair; metaDescription?: Pair }) => {
    for (const key of ['metaTitle', 'metaDescription'] as const) {
      const gap = seoPairGap(input[key]);
      if (gap) {
        throw new ValidationError(
          gap === 'ar'
            ? 'Add the Arabic text too, or leave both empty to keep the default'
            : 'Add the English text too, or leave both empty to keep the default',
          `${key}.${gap}`,
        );
      }
    }
  },
  /**
   * True when a save sets nothing (every field the page's default): with no row yet it
   * creates none (U10 D4), and answers the defaults.
   */
  isEmpty: (row: Record<string, unknown>) =>
    Object.values(META_KEYS).every((column) => blank(row[column])),
} as const;

/**
 * What the editor is told when a share image's composite key (0073) refuses a save: the id
 * names no picture of this tenant (another tenant's, or one hard-deleted since the picker
 * listed it). Bad input, so a 422 on the field, never a 500 logged as a server error.
 */
export const SHARE_IMAGE_MISSING = 'Choose a picture from the media library';

/** The share-image keys of entity_seo (0073) → the field a refusal names. */
const ENTITY_SEO_KEYS: ConstraintFields = {
  entity_seo_og_media_fk: { field: 'ogMediaId', message: SHARE_IMAGE_MISSING },
};

/**
 * The error a failed entity_seo write becomes: a unique-key race on create is the 409 it is,
 * a refused share image (23503 on its key) a 422 on `ogMediaId`, anything else a 500.
 */
export function entitySeoWriteError(
  error: { code?: string; message: string; details?: string | null },
  verb: 'create' | 'update',
): Error {
  if (verb === 'create' && error.code === '23505') return new OptimisticLockError('entity_seo');
  if (error.code === '23503') {
    const name = constraintOf(error);
    const known = name ? ENTITY_SEO_KEYS[name] : undefined;
    if (known) return new ValidationError(known.message, known.field);
  }
  return new Error(`${verb} entity_seo: ${error.message}`);
}

/** The table and columns a target type's own row is read from. */
const TARGET_TABLES: Readonly<Record<SeoEntityType, { table: string; columns: string }>> = {
  page: { table: 'pages', columns: 'id,slug,title,status' },
  service: {
    table: 'services',
    columns: 'id,slug,title,status,blurb,discipline:discipline_id(name)',
  },
  portfolio: { table: 'portfolio', columns: 'id,slug,title,status,teaser,summary,project_type' },
  blog_post: { table: 'blog_posts', columns: 'id,slug,title,status,excerpt' },
};

export function targetTable(type: SeoEntityType) {
  return TARGET_TABLES[type];
}

/**
 * The canonical override as stored (U10 D6): a site path, or null when it is blank or names
 * the page's own path (no override at all, so the page stays self-canonical in each
 * language). Reads the target's slug only when an override was sent.
 */
export async function normalizeCanonical(
  sb: SupabaseClient,
  auth: AuthContext,
  input: {
    entityType: SeoEntityType;
    entityId: string;
    canonicalOverride?: string | null | undefined;
  },
  base: string,
): Promise<string | null> {
  const path = canonicalPath(input.canonicalOverride, base);
  if (path === null) return null;
  const { table } = TARGET_TABLES[input.entityType];
  const { data, error } = await sb
    .from(table)
    .select('slug')
    .eq('tenant_id', auth.tenantId)
    .eq('id', input.entityId)
    .maybeSingle<{ slug: string }>();
  if (error) throw new Error(`read ${table}: ${error.message}`);
  const own = entityPath(input.entityType, data?.slug ?? null);
  return own !== null && own === path ? null : path;
}
