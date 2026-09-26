import { describe, it, expect } from 'vitest';
import { NavItemWriteSchema, NavItemUpdateSchema } from '@schemas/admin';

// The key link (navigation.is_key, migration 0019): the one link the header keeps in the
// bar at <=900px. At most one per location is enforced by a unique partial index; the
// schema's job is only to carry it — and never to reset it on an unrelated edit.

const base = {
  location: 'header' as const,
  label: { en: 'Contact us', ar: 'تواصل معنا' },
  href: '/contact',
};

describe('NavItem isKey', () => {
  it('defaults to false on create', () => {
    expect(NavItemWriteSchema.parse(base).isKey).toBe(false);
    expect(NavItemWriteSchema.parse({ ...base, isKey: true }).isKey).toBe(true);
  });

  it('is left alone by an update that does not name it', () => {
    // A PATCH that only renames the link must not quietly demote the key link.
    const patch = NavItemUpdateSchema.parse({ label: base.label, version: 2 });
    expect(patch.isKey).toBeUndefined();
  });

  it('rejects a non-boolean', () => {
    expect(NavItemWriteSchema.safeParse({ ...base, isKey: 'yes' }).success).toBe(false);
  });
});
