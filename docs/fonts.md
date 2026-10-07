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
| `font-display` | `swap` (never blocks render; `optional` rejected — step 2b) |
| CLS from fonts | 0 — `size-adjust` + `ascent/descent-override`, per weight and per script for Almarai (step 2b), per weight for Archivo, and per platform: Arial, or Liberation Sans + DejaVu Sans on Linux (step 2c) |

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

2b. **Almarai's fallback is per weight AND per script** (Round 3, 2026-09-29). The
   overrides above are measured against LATIN glyphs (`@capsizecss/metrics` vs Arial).
   Measured with Chromium's platform-font report (`CSS.getPlatformFontsForNode`), Almarai's
   Arabic is 26% (400) wider than Arial's and 27.7% (700) / 33.1% (800) wider than Arial
   Bold's — and a fallback face with no bold declared fakes bold from Arial regular,
   wider still from the truth. So with one face every Arabic heading, nav link, kicker,
   chip and paragraph re-wrapped when its web font arrived after first paint: cold at
   Lighthouse's desktop viewport, `/ar/about` measured 0.034–0.14 (its h1's `20ch` cap
   also widened 540 → 597 px on the swap) and `/ar/portfolio/all` 0.13–0.26 (its header is
   in flow, so the re-wrapped nav and chips pushed the whole catalogue). `global.css` now
   declares `Almarai Fallback` as six faces: for each weight (400 on Arial, 700 and 800 on
   Arial Bold) a Latin face and an Arabic-range face with its own `size-adjust`, and
   vertical overrides that follow each weight FILE's own line box (400 → 1.10em, 700 →
   1.55em, 800 → 1.10em, so `line-height: normal` boxes keep their height). The Arabic
   faces are declared after the Latin ones and claim the spaces, mirroring the web-font
   declarations. Result: widths within 1% at every weight, cold loads of `/ar/about`,
   `/ar/portfolio/all`, `/ar` and `/ar/services` at 0.000–0.003. `font-display` stays
   `swap` everywhere: `optional` was tried and rejected — Chrome holds the first paint of
   text set in an `optional` face that is still loading, and Lighthouse then puts both
   non-preloaded Arabic files on the LCP chain (`/ar/services` mobile LCP 2.62 s against
   2.5 s, twice in CI). Where Arial is absent the fallback needs faces of its own — Linux:
   step 2c; Android: still `system-ui`, unmatched. **Measure with the face actually in
   use:** a `swap` face that has not arrived, or an `optional` one that missed first paint,
   silently measures the fallback instead (that mistake cost one build here). Rule for
   headings (R3-0): never cap a swap-font heading's box in `ch` (it is the width of "0" in
   whichever font is painting); measure the cap once under the loaded face and write it in
   `em`.

2c. **Fallbacks per platform and per weight; the consent banner's box holds** (2026-10-04/05).
   With the CI pipeline waiting for every gate, the cold-load test for `/ar/portfolio/all`
   failed on the first run of #38 and of #41. Two independent adversarial reviews then shaped
   the fix. It had two causes:
   - **No matched fallback on Linux.** The CI runner (like any Linux machine) has no Arial,
     so none of the 2b faces applied. The Arabic copy fell through to `system-ui` (DejaVu
     Sans, unadjusted: 3% wider than Almarai at 400, 17% at 700, 12% at 800).
   - **The consent copy re-wraps.** At its cap, the Arabic copy sits on a two/three-line
     boundary, and the bar is pinned to the bottom edge, so it grew upward when Almarai
     arrived: 79 → 102 px at 1350 px and 131 → 154 px at 768 px (CLS 0.023 and 0.086). Its
     `60ch` cap also followed whichever "0" was painting.

   The fixes:
   - **`Almarai Fallback Linux`, a family of its own,** listed after `Almarai Fallback` in
     `--bs-font-ar`. The Arial family stays Arial-only, so where Arial is absent it resolves
     nothing and the Linux family takes every character, spaces included. Windows and macOS
     keep the Arial faces exactly as they were, even where an office suite installed these
     fonts.
     - *Latin:* Liberation Sans (Bold for 700 and 800). Its advance widths are Arial's for
       every ASCII and common typographic glyph, regular and bold (compared with fontTools,
       `hmtx`), so the Arial Latin `size-adjust` carries over.
     - *Arabic:* DejaVu Sans 2.37 (Book; Bold for 700 and 800), which draws every glyph the
       site's Arabic copy uses. `size-adjust` (96.92% / 85.63% / 89.25%) was measured in
       Chromium against 1,484 of the site's Arabic strings, with the shipped subsets and the
       HarfBuzz shaping Linux uses. Total width is within 0.25% of Almarai's; per string,
       p10/p90 is −4.4% / +3.4% (the Arial faces: −8.3% / +6.6%).
     - *Vertical overrides* target Almarai's box **as Linux draws it**. Every subset has hhea
       = typo = 0.905 / 0.211 (1.116 em), but the two 700 files lack OS/2 `USE_TYPO_METRICS`.
       So only Windows (DirectWrite) falls back to their win metrics and draws 700 at
       1.561 em, the box the Arial 700 faces copy. FreeType (Linux) and CoreText (macOS) draw
       hhea at every weight, so each Linux face has override × size-adjust = 0.905 / 0.211.
       (A first version copied the Arial faces' 1.55 em; the first review caught it.)
   - **`Archivo Fallback` per weight.** It was one weight-normal Arial face, so 600–800 text
     painted in *synthetic* bold: Arial regular's widths, 3.5% (600) to 11.2% (800) narrower
     than Archivo's.
     - *Faces:* 400 (the old face, plus Liberation Sans), 500 (Arial or Liberation regular,
       100.23%), and 600 / 700 / 800 (Arial Bold or Liberation Sans Bold, 94.77% / 98.06% /
       103.01%), each on Archivo's own box, 0.878 / 0.210. Archivo sets
       `USE_TYPO_METRICS`, so its box is the same on every platform.
     - *Calibration:* measured against 1,024 strings of the site's English copy, per string
       within −2.2% / +0.7% at p10/p90.
     - *Why not other values:* calibrating on the live pages' rendered text instead (weighted
       by font size) gave 99.90% / 95.75% / 100.19% / 105.19%. That scored better on two
       pages and worse on two others, Windows among them. A display headline near a wrap
       boundary flips at some value of any single `size-adjust`. The values kept are the ones
       with no regression against main on Windows.
     - *Why it was needed:* the second review found that adding Liberation alone (a regular
       face) had moved Linux's bold headings from real DejaVu Bold to a synthetic bold 7–8%
       too narrow.
   - **The All projects head's paragraph** was the other half of the live 0.58. Its
     `max-width: 36ch` (`work.css`) followed the painting font: 347 px in the Arial fallback,
     362 px in Archivo at 1350 px. The extra 15 px pushed the row past its width, the
     paragraph wrapped under the heading, and the catalogue dropped 120 px. It is now
     20.63 em (Archivo 400) / 19.01 em (Almarai 400).
   - **The consent copy's box:**
     - its cap is in `em` (R3-0): 60 × the "0" of the face it paints in, so Archivo 400
       0.573 em → 34.38 em and Almarai 0.528 em → 31.68 em;
     - the Arabic copy's third line is reserved (`min-height: 3lh`, on body's numeric 1.6
       line-height).

     The banner still shows at once at every width (design-port #26). A first draft held it
     back on wide screens until its fonts loaded. The first review showed it is also the LCP
     element on Arabic Contact, Services and Join up to about 1200 px, and that tablets kept
     the larger re-wrap, so the draft was dropped. Where the reservation matters:
     - *DirectWrite (Windows):* the copy is three lines in Almarai and two in the fallback at
       the cap, so the reservation keeps the box;
     - *Linux:* FreeType's whole-pixel advances set it in two lines in both, so the `em` cap
       keeps the box, and the final bar shows two lines over the reserved third;
     - *phones:* it is three lines in both.
   - **Measured.** Every font was held until the page had painted, on the live pages. Linux
     was emulated: its fonts are added before first layout as local fonts are, and Almarai,
     Archivo and the fallbacks are drawn through FreeType-style metrics. The sum over 9
     English pages × 1350 / 412 px:

     | | Linux | Windows |
     |---|---|---|
     | main | 1.67 | 0.84 |
     | now | 0.25 | 0.26 |

     Individual pages:

     | Page | main Linux | now Linux | main Windows | now Windows |
     |---|---|---|---|---|
     | `/portfolio/all` | 0.020 | 0.003 | **0.579** | **0.001** |
     | `/contact` | 0.294 | 0.003 | 0.015 | 0.001 |
     | `/about` | 0.24 / 0.33 | 0.004 / 0.041 | 0.005 | 0.0006 |

     `/ar/portfolio/all` went from 0.051 / 0.192 to 0.003 / 0.007 on Linux at 1350 / 768 px.
   - **Tests:**
     - `tests/seo/fontFallbacks.spec.ts` pins the families, faces, boxes and stack order, and
       the `em` caps and the reservation.
     - `tests/e2e/consent-banner.e2e.ts` holds the banner's box with and without its web
       fonts (EN and AR at 412 / 768 / 1024 / 1350), and checks that it is shown at
       DOMContentLoaded with every font held.
     - `tests/e2e/layout-shift.e2e.ts` runs the worst case on Linux: `/ar/portfolio/all` at
       1350 and 768, and `/portfolio/all`. It also asks the `FontFace` objects which fallback
       drew the page.
   - **Still open:**
     - *Borderline display headlines.* In the same worst case, the home hero at 412 px re-wraps
       (0.15 on both platforms; main: 0.10 Linux, 0.14 Windows), and so does Join's "Why"
       heading on Windows (0.05, as on main). The realistic cold load is clean, because the
       hero face is preloaded.
     - *Windows' per-string spread.* The Arial faces leave `/ar/portfolio/all` at 0.007–0.024
       in the worst case, against main's 0.035–0.049.
     - *The banner's button row.* A few px-wide bands where it fits beside the copy in one
       font and not the other: around 790–798 px in Arabic and 852–864 px in English, as on
       main. Below about 355 px on Arial platforms, the fallback copy runs a line longer.
     - *Almarai 700 on Windows, macOS and Linux with Arial.* The Arial 700 faces carry
       DirectWrite's 1.561 em box. That is right on Windows but 0.43 em per line too tall
       where Arial is drawn by CoreText or FreeType. Setting `USE_TYPO_METRICS` on the two
       700 subsets (`scripts/subset-fonts.py`) would make every platform draw 1.116 em, with
       one set of overrides. It is a visible change on Windows (the filter chips go from 43
       to 37 px, the mockup's height), so it is the owner's call.
     - *Android.* It has neither Arial nor these fonts, so it stays unmatched.

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
   `local('Arial')`, which Android lacks (Linux has its own faces since 2c), so the swap is
   not CLS-free there and the preload is what keeps the shift out of the window; with 2b
   and 2c the swap is metric-matched per weight where Arial or its Linux stand-ins exist,
   and the preload keeps the headline in Almarai on a first visit. `tests/seo/fonts.spec.ts` locks the hrefs and
   each preloadable face's hero budget (every Almarai arabic face is ≈ 25 KB).

4. **Verify:** `npm run a11y:contrast` (already green), then run the staged
   `perf-seo-a11y` workflow — Lighthouse asserts `font-display`, unsized-images, and the
   per-route weight budget; axe asserts zero WCAG violations on the themed output.

5. **The admin mirrors these faces.** `public/styles/admin.css` declares the same
   `@font-face` set as `global.css`, byte for byte after whitespace (Admin v2 F1), so a
   re-subset changes both files; `tests/lib/adminStyles.spec.ts` fails if they differ. The
   admin preloads nothing: `/admin` is exempt from the font budget (CLAUDE.md §6).

## What's already done

- ✅ WCAG 2.2 AA contrast audit — every UI token pair passes (lowest text pair 7.08:1 vs
  4.5 min; neon accent 12.77:1 on bg). Enforced continuously by `scripts/contrast-audit.mjs`.
- ✅ `prefers-reduced-motion` honoured globally + per-component (marquee).
- ⏳ Fonts — this runbook (needs brand woff2).
- ⏳ axe DOM pass — `tests/a11y/axe.e2e.ts`, runs in the staged `perf-seo-a11y` workflow.
