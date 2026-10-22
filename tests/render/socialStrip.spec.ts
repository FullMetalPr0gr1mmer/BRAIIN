import { describe, expect, test } from 'vitest';
import type { Identity } from '@/lib/identity/fallback';
import { IDENTITY } from './fixtures';
import { LOCALES, renderSections } from './harness';

// The Social section from the identity's accounts (Admin v2 U9): an account with "Show on the
// site" off leaves the page (decision D8, and the Organization JSON-LD's sameAs with it,
// tests/seo/siteIcons.spec.ts); with every account shown the section is the one served before
// U9, which tests/render/sections.spec.ts's snapshot holds to the byte.

const section = [{ type: 'social' as const, props: {} }];

describe('SocialStrip and "Show on the site"', () => {
  for (const locale of LOCALES) {
    test(`${locale}: a hidden account is not on the page; the shown ones are, in order`, async () => {
      const [first, second, ...rest] = IDENTITY.socials;
      const identity: Identity = {
        ...IDENTITY,
        socials: [first!, { ...second!, visible: false }, ...rest],
      };
      const all = await renderSections(section, locale);
      const some = await renderSections(section, locale, identity);
      expect(all).toContain(`href="${second!.url}"`);
      expect(some).not.toContain(`href="${second!.url}"`);
      expect(some).toContain(`href="${first!.url}"`);
      for (const s of rest) expect(some).toContain(`href="${s.url}"`);
    });
  }
});
