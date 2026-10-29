import type { ReleaseEntityType } from '@schemas/release';
import { RESOURCES } from '@/lib/admin/resources';
import type { ResourceConfig } from '@/lib/admin/resource';
import { RESOURCE_UI, SINGLETON_UI } from '@/lib/admin/ui';
import type { FieldDef } from '@/lib/admin/ui';
import { RELEASE_REGISTRY, type RegistryEntry } from './registry';

// What a pending change is called in the admin (Admin v2 R12): where it is edited, and the
// fields it changes in the editor's own words. SERVER ONLY (the registry). The publish dialog
// and the savebar (src/components/admin/screens/release/) list a change as "Logo Design ·
// Title, Intro, +2 · Fix", and both the address and the words are the editor's, read once per
// type here from the resource and singleton UI configs, so the dialog ships no copy of them.
//
// A stored change names its columns (`content_drafts.fields`, the patch's columns and child
// keys, R3a); each column is put back to the payload key that writes it (the registry's
// `fields` map) and named by that key's field label. A column no field names (a derived one,
// a type with no UI config) reads as its key in plain words.

/** The admin slug of each kernel resource, by its config (RESOURCES is keyed by slug). */
const SLUG_OF = new Map<ResourceConfig, string>(
  Object.entries(RESOURCES).map(([slug, config]) => [config, slug]),
);

/** The singleton editors by the release type they edit (src/lib/admin/ui SINGLETON_UI keys). */
const SINGLETON_UI_OF: Partial<Record<ReleaseEntityType, string>> = {
  site_profile: 'profile',
  seo_defaults: 'seo',
  // Admin v2 E5: the Header screen's form.
  site_appearance: 'appearance',
};

/** Where each non-resource type is edited (its screen, which opens on the row itself). */
const SCREEN_OF: Partial<Record<ReleaseEntityType, string>> = {
  site_profile: '/admin/settings',
  seo_defaults: '/admin/seo?tab=site',
  entity_seo: '/admin/seo',
  page_visibility: '/admin/visibility',
  // Admin v2 E5: the Header screen edits the header's options.
  site_appearance: '/admin/appearance/header',
};

/** Where a pending change of this entity is edited, or null when no screen edits it. */
export function editHref(entityType: ReleaseEntityType, entityId: string): string | null {
  const entry = RELEASE_REGISTRY[entityType];
  if (entry.resource) {
    const slug = SLUG_OF.get(entry.resource);
    return slug ? `/admin/${slug}/${entityId}` : null;
  }
  return SCREEN_OF[entityType] ?? null;
}

/** "metaTitle" or "og_media_id" as words: "Meta title", "Og media". */
export function plainWords(key: string): string {
  const words = key
    .replace(/_id$/, '')
    .replace(/Id$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

function uiFields(entry: RegistryEntry): readonly FieldDef[] {
  if (entry.resource) {
    const slug = SLUG_OF.get(entry.resource);
    return (slug ? RESOURCE_UI[slug]?.fields : undefined) ?? [];
  }
  const key = SINGLETON_UI_OF[entry.entityType];
  return (key ? SINGLETON_UI[key]?.fields : undefined) ?? [];
}

/** Per type: a column (or child key) → its words. Built once per isolate. */
const LABELS = new Map<ReleaseEntityType, ReadonlyMap<string, string>>();

function labelsOf(entityType: ReleaseEntityType): ReadonlyMap<string, string> {
  const known = LABELS.get(entityType);
  if (known) return known;
  const entry = RELEASE_REGISTRY[entityType];
  const byName = new Map(uiFields(entry).map((f) => [f.name, f.label]));
  const out = new Map<string, string>();
  for (const [key, columns] of Object.entries(entry.fields)) {
    const label = byName.get(key) ?? plainWords(key);
    for (const column of columns) if (!out.has(column)) out.set(column, label);
  }
  // Child sets are stored under their payload key (portfolio: serviceIds, media).
  for (const key of entry.childKeys) out.set(key, byName.get(key) ?? plainWords(key));
  LABELS.set(entityType, out);
  return out;
}

/** The words for a change's stored fields, each once, in the order stored. */
export function fieldLabels(entityType: ReleaseEntityType, fields: readonly string[]): string[] {
  const labels = labelsOf(entityType);
  return [...new Set(fields.map((f) => labels.get(f) ?? plainWords(f)))];
}

/** The words for one column (Compare's rows). */
export function columnLabel(entityType: ReleaseEntityType, column: string): string {
  return labelsOf(entityType).get(column) ?? plainWords(column);
}
