import type { Locale } from '@schemas/primitives';
import {
  getEntitySeo,
  getSeoDefaults,
  resolveSeo,
  type EntityType,
  type ResolvedSeo,
} from '@/lib/data/seo';
import { getIdentity, brandName, type Identity } from '@/lib/identity';

// Everything a public route needs for its <head>, in ONE round of concurrent reads:
// the public identity (brand for the title template, og:site_name, JSON-LD), the tenant
// SEO defaults, and — when the page has one — its per-entity override (`entity_seo`).
//
// Why one loader rather than a helper per case: every Tier-A render pays for these
// reads (Worker responses are SSR'd per request), and each one awaited in turn adds a
// full database round-trip to time-to-first-byte. Measured on the preview, chaining
// identity → defaults after the page query doubled TTFB (~300ms → ~600ms). Here they
// share one round; the identity promise is memoised on `locals`, so the header, footer
// and <SeoHead> that ask again later cost nothing.
//
// Never throws: every read degrades (identity → code fallback, SEO → null), so a lookup
// failing never 500s a content page.

export interface EntityRef {
  type: EntityType;
  id: string;
}

export interface Head {
  seo: ResolvedSeo;
  identity: Identity;
  /** The brand in the page's language (the title template's %brand%). */
  brand: string;
}

export async function loadHead(
  locals: Pick<App.Locals, 'identity'>,
  options: {
    locale: Locale;
    fallbackTitle: string;
    fallbackDescription?: string;
    /**
     * The page's own row, for its `entity_seo` override. May be a promise, so a route can
     * start its content query and this loader together — a section-composed page only
     * learns its page id from the composition query.
     */
    entity?: EntityRef | null | Promise<EntityRef | null>;
  },
): Promise<Head> {
  const entitySeo = Promise.resolve(options.entity ?? null).then((ref) =>
    ref ? getEntitySeo(ref.type, ref.id) : null,
  );
  const [identity, defaults, entity] = await Promise.all([
    getIdentity(locals),
    getSeoDefaults(),
    entitySeo,
  ]);
  const brand = brandName(identity, options.locale);
  const seo = resolveSeo({
    locale: options.locale,
    brand,
    entity,
    defaults,
    fallbackTitle: options.fallbackTitle,
    ...(options.fallbackDescription === undefined
      ? {}
      : { fallbackDescription: options.fallbackDescription }),
  });
  return { seo, identity, brand };
}
