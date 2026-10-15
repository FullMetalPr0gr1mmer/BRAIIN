import { CertificationUpdateSchema, CertificationWriteSchema } from '@schemas/admin';
import type { ResourceConfig } from '../resource';
import { fieldsOf, pick, requireBilingual, statusOf, type Input } from './shared';

// Certifications.

const CERTIFICATION_KEYS = {
  slug: 'slug',
  name: 'name',
  issuer: 'issuer',
  year: 'year',
  logoUrl: 'logo_url',
  status: 'status',
  sortOrder: 'sort_order',
};

export const certificationResource: ResourceConfig = {
  table: 'certifications',
  entity: 'certification',
  writeCap: 'services.write',
  listColumns: 'id,slug,name,year,status,sort_order,version,updated_at',
  columns: 'id,slug,name,issuer,year,logo_url,status,sort_order,version,created_at,updated_at',
  orderBy: { column: 'sort_order', ascending: true },
  searchColumn: 'slug',
  createSchema: CertificationWriteSchema,
  updateSchema: CertificationUpdateSchema,
  // No publish stamp: this toRow writes no published_at.
  toRow: (input) => pick(input as Input, CERTIFICATION_KEYS),
  fields: fieldsOf(CERTIFICATION_KEYS),
  statusOf: (input) => statusOf(input as Input),
  assertPublishable: (row) => requireBilingual(row, 'name', 'Certification name'),
};
