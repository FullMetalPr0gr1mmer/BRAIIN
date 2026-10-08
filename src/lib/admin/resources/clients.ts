import { ClientUpdateSchema, ClientWriteSchema } from '@schemas/admin';
import type { ResourceConfig } from '../resource';
import { pick, refusePlaceholder, requireBilingual, type Input } from './shared';

// Clients (UI v2, 0021): `visible` is the permission to name the client on the site.

export const clientResource: ResourceConfig = {
  table: 'clients',
  entity: 'client',
  writeCap: 'portfolio.write',
  // Read by SEO too: the case-study editor's Client picker (RLS: clients_read, staff).
  readCaps: ['portfolio.write', 'seo.entityMeta'],
  // `visible` IS the public-disclosure permission: turning it on names a client on the
  // site, so it is gated like a publish (content.publish + the rules below).
  publishFlag: 'visible',
  constraintFields: {
    clients_slug_check: {
      field: 'slug',
      message: 'lowercase letters, digits and hyphens, at most 64',
    },
    clients_tenant_id_slug_key: { field: 'slug', message: 'another client already uses this slug' },
    clients_website_url_check: {
      field: 'websiteUrl',
      message: 'an https:// address, at most 300 characters',
    },
  },
  listColumns: 'id,slug,name,show_in_marquee,visible,is_placeholder,sort_order,version,updated_at',
  columns:
    'id,slug,name,logo_media_id,website_url,show_in_marquee,visible,is_placeholder,sort_order,' +
    'version,created_at,updated_at',
  orderBy: { column: 'sort_order', ascending: true },
  searchColumn: 'slug',
  filterableColumns: ['show_in_marquee', 'visible'],
  createSchema: ClientWriteSchema,
  updateSchema: ClientUpdateSchema,
  toRow: (input) =>
    pick(input as Input, {
      slug: 'slug',
      name: 'name',
      logoMediaId: 'logo_media_id',
      websiteUrl: 'website_url',
      showInMarquee: 'show_in_marquee',
      visible: 'visible',
      isPlaceholder: 'is_placeholder',
      sortOrder: 'sort_order',
    }),
  assertPublishable: (row) => {
    requireBilingual(row, 'name', 'Client name');
    refusePlaceholder(row, 'client');
  },
};
