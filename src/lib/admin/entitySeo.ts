import { z } from 'zod';
import { EntitySeoWriteSchema } from '@schemas/admin';
import { ValidationError } from './errors';

// Per-entity SEO metadata (`seo.entityMeta` — Admin + SEO write, Content Creator view):
// the table, its columns, the request shapes and the payload → column mapping the
// /api/admin/entity-seo route uses, moved out of the route file (Admin v2 R2) so the
// release registry can bind them without importing a route. What the route writes is
// unchanged (tests/lib/releaseOffWrites.spec.ts).
//
// The row is keyed by its target, (entity_type, entity_id), not by its own id: the caller
// always knows what it is editing the meta for. The write is a full replace (PUT): every
// optional column the payload leaves out is written as null.

const COLUMNS =
  'id,entity_type,entity_id,meta_title,meta_description,og_image,canonical_override,robots,schema_type,version,updated_at';

const LookupSchema = z.object({
  entityType: z.enum(['service', 'blog_post', 'portfolio', 'page']),
  entityId: z.string().uuid(),
});

const WriteSchema = EntitySeoWriteSchema.extend({ version: z.number().int().min(0) });

const DEFAULTS = {
  meta_title: {},
  meta_description: {},
  og_image: null,
  canonical_override: null,
  robots: null,
  schema_type: null,
  version: 0,
};

/** Payload key → column for the meta itself (every save writes all six). */
const META_KEYS = {
  metaTitle: 'meta_title',
  metaDescription: 'meta_description',
  ogImage: 'og_image',
  canonicalOverride: 'canonical_override',
  robots: 'robots',
  schemaType: 'schema_type',
} as const;

/** Payload key → column for the target, set once when the row is created. */
const TARGET_KEYS = { entityType: 'entity_type', entityId: 'entity_id' } as const;

type WriteInput = z.infer<typeof WriteSchema>;

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
    meta_title: input.metaTitle,
    meta_description: input.metaDescription,
    og_image: input.ogImage ?? null,
    canonical_override: input.canonicalOverride ?? null,
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
   * Both meta fields are bilingual-required by the schema. Restated as a domain check
   * because CI blocks empty `meta_*_ar` (Pillar 3) and the error message an editor sees
   * should name the problem, not read like a schema dump.
   */
  assertBilingual: (input: Pick<WriteInput, 'metaTitle' | 'metaDescription'>) => {
    if (!input.metaTitle.ar || !input.metaDescription.ar) {
      throw new ValidationError('Arabic meta title and description are required', 'metaTitle.ar');
    }
  },
} as const;
