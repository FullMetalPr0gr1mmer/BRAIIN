import { describe, it, expect } from 'vitest';
import { ROLE_CAPS, type Capability } from '@/lib/authz/matrix';
import { ROLES, type Role } from '@/lib/auth/types';
import { RESOURCES } from '@/lib/admin/resources';
import { CONTENT_AREAS, RELEASE_ENTITY_META } from '@/lib/release/areas';
import {
  PUBLISH_CAP_LABEL,
  RELEASE_ANY_CAP,
  canPublish,
  isRemoval,
  keepsArchived,
  publishableAreas,
  publishableByArea,
  requiredCaps,
  waitingFor,
} from '@/lib/release/caps';
import { RELEASE_AREAS, RELEASE_ENTITY_TYPES, type ReleaseEntityType } from '@schemas/release';

// Who may publish a pending change (Admin v2 R2; releases.md §4.1): derived from ROLE_CAPS,
// never a new capability. Each case below is what that role can already make live by
// saving today (program decision P-2), per item kind.

const CONTENT_TYPES = RELEASE_ENTITY_TYPES.filter((t) =>
  CONTENT_AREAS.includes(RELEASE_ENTITY_META[t].area),
);
const STATUS_TYPES = RELEASE_ENTITY_TYPES.filter((t) => RELEASE_ENTITY_META[t].hasStatus);
const holders = (cap: Capability) => ROLES.filter((role) => ROLE_CAPS[role][cap] === 'full');

describe('requiredCaps', () => {
  it('a content create or edit needs its write capability and content.publish', () => {
    for (const entityType of CONTENT_TYPES) {
      const meta = RELEASE_ENTITY_META[entityType];
      for (const op of ['create', 'update'] as const) {
        expect(requiredCaps({ entityType, op })).toEqual([meta.authorCaps[0], 'content.publish']);
      }
    }
  });

  it('a content removal or archive adds content.archiveDelete', () => {
    for (const entityType of CONTENT_TYPES) {
      const meta = RELEASE_ENTITY_META[entityType];
      const removal = [meta.authorCaps[0], 'content.publish', 'content.archiveDelete'];
      expect(requiredCaps({ entityType, op: 'delete' })).toEqual(removal);
      if (meta.hasStatus) {
        const archive = { entityType, op: 'update' as const, patch: { status: 'archived' } };
        expect(isRemoval(archive)).toBe(true);
        expect(requiredCaps(archive)).toEqual(removal);
      }
    }
  });

  it('other status changes and a visible flip need nothing more than an edit', () => {
    for (const entityType of STATUS_TYPES) {
      for (const status of ['draft', 'published']) {
        const item = { entityType, op: 'update' as const, patch: { status } };
        expect(requiredCaps(item)).toEqual(RELEASE_ENTITY_META[entityType].authorCaps);
      }
    }
    for (const entityType of RELEASE_ENTITY_TYPES.filter(
      (t) => RELEASE_ENTITY_META[t].publishFlag === 'visible',
    )) {
      const item = { entityType, op: 'update' as const, patch: { visible: true } };
      expect(requiredCaps(item)).toContain('content.publish');
      expect(requiredCaps(item)).toEqual(RELEASE_ENTITY_META[entityType].authorCaps);
    }
  });

  it('`archived` is only a removal where status is a content lifecycle', () => {
    // A redirect's status is its HTTP code; no value of it archives anything.
    const item = { entityType: 'redirect' as const, op: 'update' as const, patch: { status: 301 } };
    expect(isRemoval(item)).toBe(false);
    const odd = {
      entityType: 'nav_item' as const,
      op: 'update' as const,
      patch: { status: 'archived' },
    };
    expect(isRemoval(odd)).toBe(false);
  });

  it('identity, theme, SEO and redirects need their own capability', () => {
    expect(requiredCaps({ entityType: 'site_profile', op: 'update' })).toEqual([
      'settings.general',
    ]);
    expect(requiredCaps({ entityType: 'custom_theme', op: 'update' })).toEqual(['theme.edit']);
    expect(requiredCaps({ entityType: 'custom_theme', op: 'delete' })).toEqual([
      'theme.edit',
      'content.archiveDelete',
    ]);
    expect(requiredCaps({ entityType: 'entity_seo', op: 'create' })).toEqual(['seo.entityMeta']);
    expect(requiredCaps({ entityType: 'seo_defaults', op: 'update' })).toEqual([
      'seo.globalDefaults',
    ]);
    expect(requiredCaps({ entityType: 'redirect', op: 'delete' })).toEqual(['redirects.manage']);
  });

  it('a type a release never removes has no removal anyone may publish', () => {
    for (const entityType of ['site_profile', 'seo_defaults', 'entity_seo'] as const) {
      expect(requiredCaps({ entityType, op: 'delete' })).toBeNull();
      expect(waitingFor({ entityType, op: 'delete' })).toEqual([]);
    }
  });
});

describe('keepsArchived: a change that leaves an archived row archived (hotfix H12)', () => {
  // The archive gates refuse anyone but an Admin an update that leaves a row archived, and the
  // apply runs as the publisher, so such a change is an Admin's to publish, as an archive is.
  it('an edit of a row archived live that sets no status needs content.archiveDelete', () => {
    for (const entityType of STATUS_TYPES) {
      const meta = RELEASE_ENTITY_META[entityType];
      const removal = [meta.authorCaps[0], 'content.publish', 'content.archiveDelete'];
      for (const patch of [null, { sort_order: 5 }, { title: { en: 'A' } }]) {
        const item = { entityType, op: 'update' as const, patch, liveStatus: 'archived' };
        expect(keepsArchived(item), entityType).toBe(true);
        expect(isRemoval(item), entityType).toBe(false);
        expect(requiredCaps(item), entityType).toEqual(removal);
        expect(waitingFor(item), entityType).toEqual(['admin']);
        expect(canPublish('content_creator', item), entityType).toBe(false);
        expect(canPublish('admin', item), entityType).toBe(true);
      }
    }
  });

  it('a restore (any status of its own) is an edit, as an immediate save of it is', () => {
    for (const entityType of STATUS_TYPES) {
      for (const status of ['draft', 'scheduled', 'published']) {
        const item = {
          entityType,
          op: 'update' as const,
          patch: { status },
          liveStatus: 'archived',
        };
        expect(keepsArchived(item)).toBe(false);
        expect(requiredCaps(item)).toEqual(RELEASE_ENTITY_META[entityType].authorCaps);
      }
    }
  });

  it('only an update of a row archived live, of a type with a lifecycle', () => {
    for (const entityType of STATUS_TYPES) {
      for (const liveStatus of [undefined, null, 'draft', 'published', 'scheduled']) {
        const item = { entityType, op: 'update' as const, liveStatus };
        expect(keepsArchived(item), `${entityType} ${String(liveStatus)}`).toBe(false);
      }
      expect(keepsArchived({ entityType, op: 'create', liveStatus: 'archived' })).toBe(false);
      // A delete is a removal already: nothing more to add.
      expect(keepsArchived({ entityType, op: 'delete', liveStatus: 'archived' })).toBe(false);
    }
    // A redirect's status is its HTTP code, a nav item has none: neither is ever archived.
    for (const entityType of ['redirect', 'nav_item', 'page_section', 'site_profile'] as const) {
      expect(keepsArchived({ entityType, op: 'update', liveStatus: 'archived' })).toBe(false);
    }
  });
});

describe('waitingFor: the roles that could publish it', () => {
  const EXPECTED: Record<string, { edit: Role[]; remove: Role[] }> = {
    content: { edit: ['admin', 'content_creator'], remove: ['admin'] },
    site_profile: { edit: ['admin', 'developer'], remove: [] },
    custom_theme: { edit: ['admin', 'developer'], remove: ['admin'] },
    entity_seo: { edit: ['admin', 'seo'], remove: [] },
    seo_defaults: { edit: ['admin', 'seo'], remove: [] },
    redirect: { edit: ['admin', 'seo'], remove: ['admin', 'seo'] },
    // §5 "Maintenance / hidden pages / page visibility" (Admin v2 U14a); never removed.
    page_visibility: { edit: ['admin', 'developer'], remove: [] },
    // P-2 "Theme + header/intro appearance": theme.edit (Admin v2 E5); never removed.
    site_appearance: { edit: ['admin', 'developer'], remove: [] },
    // P-2 "Identity + footer + forms config": settings.general (Admin v2 E8); never removed.
    form_settings: { edit: ['admin', 'developer'], remove: [] },
  };

  for (const entityType of RELEASE_ENTITY_TYPES) {
    it(entityType, () => {
      const expected = EXPECTED[CONTENT_TYPES.includes(entityType) ? 'content' : entityType]!;
      expect(waitingFor({ entityType, op: 'create' })).toEqual(expected.edit);
      expect(waitingFor({ entityType, op: 'update' })).toEqual(expected.edit);
      expect(waitingFor({ entityType, op: 'delete' })).toEqual(expected.remove);
      for (const role of ROLES) {
        expect(canPublish(role, { entityType, op: 'update' })).toBe(expected.edit.includes(role));
      }
    });
  }
});

describe('a go-live flag changes no outcome (decision D5)', () => {
  // `visible` → true is gated by content.publish on top of the write capability. That
  // changes nothing only while every holder of the write capability also holds
  // content.publish; a future role with categories.manage or nav.edit but not
  // content.publish would make the flag a real refusal, so it must fail here first.
  it('every holder of a flagged config’s write capability holds content.publish', () => {
    const flagged = Object.values(RESOURCES).filter((c) => c.publishFlag === 'visible');
    expect(flagged.map((c) => c.entity).sort()).toEqual([
      'client',
      'nav_item',
      'page_section',
      'sector',
    ]);
    const publishers = new Set(holders('content.publish'));
    for (const config of flagged) {
      for (const role of holders(config.writeCap)) {
        expect(publishers.has(role), `${role} on ${config.entity}`).toBe(true);
      }
    }
  });

  it('the two configs that gained the flag have no go-live rules of their own', () => {
    expect(RESOURCES['sectors']!.assertPublishable).toBeUndefined();
    expect(RESOURCES['navigation']!.assertPublishable).toBeUndefined();
  });
});

describe('areas', () => {
  it('each role publishes the areas its capabilities reach', () => {
    expect(publishableAreas('admin')).toEqual([...RELEASE_AREAS]);
    expect(publishableAreas('content_creator')).toEqual([...CONTENT_AREAS]);
    expect(publishableAreas('seo')).toEqual(['seo']);
    expect(publishableAreas('developer')).toEqual(['settings', 'appearance']);
    for (const role of ROLES) {
      const by = publishableByArea(role);
      expect(Object.keys(by).sort()).toEqual([...RELEASE_AREAS].sort());
      expect(RELEASE_AREAS.filter((a) => by[a])).toEqual(publishableAreas(role));
    }
  });

  it('every area has at least one type', () => {
    const used = new Set(RELEASE_ENTITY_TYPES.map((t) => RELEASE_ENTITY_META[t].area));
    expect([...used].sort()).toEqual([...RELEASE_AREAS].sort());
  });
});

describe('the publish routes’ capability set', () => {
  it('is labelled content.publish', () => {
    expect(PUBLISH_CAP_LABEL).toBe('content.publish');
  });

  it('admits exactly the roles that can publish something', () => {
    for (const role of ROLES) {
      const holdsOne = RELEASE_ANY_CAP.some((cap) => ROLE_CAPS[role][cap] === 'full');
      const canAny = RELEASE_ENTITY_TYPES.some((entityType: ReleaseEntityType) =>
        canPublish(role, { entityType, op: 'update' }),
      );
      expect(holdsOne, role).toBe(canAny);
    }
  });

  it('names only capabilities some item requires', () => {
    const required = new Set(
      RELEASE_ENTITY_TYPES.flatMap((entityType) => RELEASE_ENTITY_META[entityType].authorCaps),
    );
    for (const cap of RELEASE_ANY_CAP) expect(required.has(cap), cap).toBe(true);
  });
});
