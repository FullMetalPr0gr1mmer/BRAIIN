---
paths:
  - 'src/pages/**'
  - 'src/components/**'
  - 'src/layouts/**'
  - 'astro.config.*'
---

# Public frontend — Performance (Pillar 2) + SEO/GEO/AEO & i18n (Pillar 3)

> Path-scoped reminder. **Canonical: `CLAUDE.md` §3 (Pillars 2 & 3), §6 (budgets), §8 (i18n). CLAUDE.md wins on any conflict.** Budgets apply to **public routes only**; `/admin` is exempt from CWV (bundle-size gated only).

## Performance — failing any budget = blocked PR

- LCP < 2.5s · INP < 200ms (field RUM is the source of truth; CI uses TBT ≤ 200ms) · CLS < 0.1 · Lighthouse Perf/A11y/SEO ≥ 95 each (incl. an `/ar/` RTL route).
- Per-route client JS ≤ 100 KB gz (`hls.js` post-LCP, excluded) · EN+AR fonts ≤ 180 KB/route · poster ≤ 80 KB · media CLS = 0.
- Astro `<Picture>` only (explicit width/height). Islands `client:visible`/`client:idle`.
- Video via **Cloudflare Stream only**; poster is the LCP `<img>`; `preload="none"`; `hls.js` loads post-LCP; **zero video bytes before intersection** (CI-asserted).
- Self-hosted subset woff2, `font-display:swap` + metric-overrides, preload only the hero face. Compositor-only animation; `content-visibility:auto`; honour reduced-motion.

## SEO / GEO / AEO & i18n

- **Indexability hard rule:** all rankable/citable content in server-rendered HTML (Tier A) — never hydrate it client-side. Reviewers reject PRs that do.
- One `<head>` choke point — `<SeoHead>` / `<JsonLd>`; don't emit head tags elsewhere.
- **i18n:** path-based `/` (EN) + `/ar/` (AR). Build **both** twins; both in the sitemap. Reciprocal `hreflang` + `x-default`→EN; per-language self-referential canonicals. AR meta/OG are **first-class & Zod-required** — CI blocks empty `meta_*_ar`.
- 8 JSON-LD types validated in CI (EN+AR); truthful `dateModified`. Sitemaps + `llms.txt` regenerate on publish.
- GEO authoring: answer-first 40–60w, named stats, E-E-A-T author pages (no anonymous authorship).
