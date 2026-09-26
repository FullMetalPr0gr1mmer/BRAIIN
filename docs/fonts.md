# Font self-hosting + subsetting runbook (KAN-23)

> **Re-subset 2026-09-25 (Almarai).** `scripts/subset-fonts.py` tightened the six Almarai
> files — arabic ≈ 25 KB (the Arabic block U+0600–06FF + space/nbsp/joiners; contextual and
> lam-alef glyphs kept via the GSUB closure) and latin ≈ 10 KB (ASCII + the marks the copy
> uses). A route loading every face now pulls **≈ 105 KB, down from ≈ 152 KB**. It was a
> budget failure, not a tidy-up: Lighthouse treats font requests as render-blocking, and
> the day `perf-seo-a11y` first ran as a PR gate `/ar` missed LCP (2.50–2.52 s vs < 2.5 s)
> and performance (0.94 vs ≥ 0.95); after, locally, LCP ≈ 2.24 s and 0.95–0.96. The same
> change declares each weight's latin face BEFORE its arabic face and lets the arabic face
> claim U+0020/U+00A0, so spaces in Arabic text no longer pull in the latin file. Verified
> glyph-for-glyph: full-page screenshots of /ar, /ar/about, /ar/contact, /ar/services and
> / before/after are pixel-identical (2 px of antialiasing on /ar), and a scan of the
> visible text of every public AR route found no code point outside the new ranges.
> **The unicode-range descriptors in global.css must match the script's ranges.**
>
> **Status: EXECUTED (2026-08-21).** The brand landed as **Archivo** (EN) + **Almarai**
> (AR) with the approved "Brain Station UI" design. Shipped in `public/fonts/`:
> `archivo-var-latin.woff2` (ONE variable face, wght 400–800, latin subset, **34.9 KB** —
> inside the 35 KB Latin hero budget and the only Latin file a route loads) and Almarai
> 400/700/800 × {arabic, latin} static subsets (arabic ≤ 33.4 KB each; worst-case AR
> route ≈ 152 KB — inside 180 KB). `@font-face` + metric-override fallback faces
> (`Archivo Fallback`/`Almarai Fallback`, values from `@capsizecss/metrics` vs Arial)
> live in `public/styles/global.css`; the per-locale hero-face preload lives in
> `src/components/SeoHead.astro`. Subsetting used Google Fonts' per-script split (same
> unicode-ranges as below) rather than pyftsubset — re-run pyftsubset only if the brand
> ever moves off Google-hosted sources. Canonical budgets: `CLAUDE.md` §6.

## Budgets (CI-enforced via size-limit / Lighthouse once active)

| Item | Budget |
|---|---|
| EN + AR fonts **per route** | ≤ 180 KB woff2 (AR face counts) |
| Hero face (the one preloaded — per route) | ≤ 35 KB Latin / 45 KB Arabic |
| `font-display` | `swap` (never blocks render) |
| CLS from fonts | 0 — via `size-adjust` + `ascent/descent-override` |

## Steps

1. **Subset per script** (Latin for EN, Arabic for AR) — don't ship one giant face:
   ```bash
   # pip install fonttools brotli
   pyftsubset Brand.ttf --output-file=brand-latin.woff2 --flavor=woff2 \
     --unicodes=U+0000-00FF,U+0131,U+0152-0153,U+2000-206F,U+2074,U+20AC
   pyftsubset Brand-Arabic.ttf --output-file=brand-arabic.woff2 --flavor=woff2 \
     --unicodes=U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF,U+0660-0669
   ```
   Drop the woff2 into `public/fonts/`. Verify each face is within the hero budget.

2. **Declare `@font-face` with metric-overrides** (in `public/styles/global.css`). The
   override values come from comparing the brand face to the current fallback
   (`system-ui`) — generate with the Fontaine/`@capsizecss/metrics` approach so the
   fallback box matches the webfont box ⇒ **zero CLS on swap**:
   ```css
   @font-face {
     font-family: 'Brand';
     src: url('/fonts/brand-latin.woff2') format('woff2');
     font-weight: 400 700;          /* if variable */
     font-display: swap;
     unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+2000-206F, U+20AC;
   }
   @font-face {
     font-family: 'Brand';
     src: url('/fonts/brand-arabic.woff2') format('woff2');
     font-weight: 400 700;
     font-display: swap;
     unicode-range: U+0600-06FF, U+0750-077F, U+FB50-FDFF, U+FE70-FEFF, U+0660-0669;
   }
   /* metric-matched fallback to kill CLS */
   @font-face {
     font-family: 'Brand-fallback';
     src: local('Arial');
     size-adjust: 100%;            /* ← measured */
     ascent-override: 90%;         /* ← measured */
     descent-override: 22%;        /* ← measured */
     line-gap-override: 0%;
   }
   :root { --bs-font-sans: 'Brand', 'Brand-fallback', system-ui, sans-serif; }
   ```

3. **Preload ONLY the hero face** (the one above the fold), per locale, in
   `src/components/SeoHead.astro` — preloading more than one face wastes the budget:
   ```html
   <link rel="preload" href="/fonts/brand-latin.woff2" as="font" type="font/woff2" crossorigin />
   <!-- on /ar/*, preload brand-arabic.woff2 instead -->
   ```
   **The Arabic hero face is per route** (2026-09-27). Almarai is static, so the face to
   preload is the weight the route's above-the-fold heading actually renders in — a CSS
   weight with no file of its own resolves to a neighbour (600 → 700). The href comes from
   `heroFontPreload()` in `src/lib/seo/fonts.ts`; a route picks the face with BaseLayout's
   `heroFace` prop (`almarai-800` by default — Home's hero; `almarai-700` on About, whose h1
   is weight 600). Still exactly one preload. Why: `/ar/about` preloaded 800 while its h1
   rendered in 700, and the late 700 swap reflowed the split heading — Lighthouse CLS 0.14
   against the 0.1 budget, on `/ar/about` only. The `Almarai Fallback` metrics are tuned to
   `local('Arial')`, which Linux/Android lack, so the swap is not CLS-free there and the
   preload is what keeps the shift out of the window. `tests/seo/fonts.spec.ts` locks the
   hrefs and each preloadable face's hero budget (every Almarai arabic face is ≈ 25 KB).

4. **Verify:** `npm run a11y:contrast` (already green), then run the staged
   `perf-seo-a11y` workflow — Lighthouse asserts `font-display`, unsized-images, and the
   per-route weight budget; axe asserts zero WCAG violations on the themed output.

## What's already done

- ✅ WCAG 2.2 AA contrast audit — every UI token pair passes (lowest text pair 7.08:1 vs
  4.5 min; neon accent 12.77:1 on bg). Enforced continuously by `scripts/contrast-audit.mjs`.
- ✅ `prefers-reduced-motion` honoured globally + per-component (marquee).
- ⏳ Fonts — this runbook (needs brand woff2).
- ⏳ axe DOM pass — `tests/a11y/axe.e2e.ts`, runs in the staged `perf-seo-a11y` workflow.
