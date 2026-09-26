# UI v2 design port (2026-09) — decisions and deviations

The "Brain Station UI" delivery (2026-09-25) is ported **as is** in look and copy, and
re-implemented under the site's standard (CLAUDE.md): server-rendered, nonce CSP (no inline
style or script), compositor-only motion, WCAG 2.2 AA, EN + `/ar` RTL. This file records
every place the port chooses something the mockup does not say, or deliberately does
differently. It grows with each UI v2 PR; PR14 completes it.

## Shared components (PR6)

| Mockup | Site | Where |
|---|---|---|
| `.media` + `bindClip()` | `MediaFrame.astro` (`.mf`) + `src/lib/client/clips.ts` | cards, featured project, Our Work intro, About, final film |
| catalog `.card`, home `.sw-card` | `ProjectCard.astro` (`.pcard--catalog` / `--home`) | Our Work, All projects, home |
| `.tagb` / `.sw-tag` / `.pt__tag` | `FacetTags.astro` (`.facets--dark` / `--light` / `--case`, `.ftag`) | cards, case-study title band |
| `.nums` / `.reach` / `.proof .stats` | `StatBand.astro` (`.sb--band` / `--reach` / `--proof`) + `countUp.ts` | home, About, Our Work |
| `.tm` / `.quotes` | `Testimonials.astro` (`.tm--klein` / `--light`) + `carousel.ts` | home, Our Work |
| work `.lead` | `LeadBand.astro` (`.lead-band`) | Our Work, All projects, case study |
| badge `.cta`, `.cta--light`, `.cta--klein` | `Cta.astro` (`.cta--badge` + `--klein` / `--light`, `--go` / `--down`) | sitewide |
| `.skip` / `.btn` | the existing `.cta` (+ `.cta--trail` glyph sizing) | hero, forms |
| about `splitWords()` | `SplitHeading.astro` (`.h-split`, server-split words) | About h1 |
| `<em>` inside I18N strings | `AccentText.astro` + `splitAccent()` (a per-locale word RANGE) | every accented heading |

Classes are namespaced: the mockup's `.lead`, `.stat`, `.cta` and `.sec__head` collide with
existing global.css utilities.

## Decisions (PR6)

1. **No clip autoplay on touch** (EXC-007/EXC-009): touch devices see the poster. The mockup
   autoplayed catalog cards at 60 % visibility and every in-view clip on touch. A finger on a
   hybrid's touchscreen never starts a hover preview either (only a mouse or pen does). The
   play badge shows only where a clip can actually play — never on touch, under reduced
   motion, with Save-Data or without JS (the mockup showed it everywhere).
2. **A paused clip gives the poster back** (and the play badge). The mockup never removed
   `.is-playing`, leaving a frozen video frame up.
3. **Clips never join the background sync group**: each is a different window of one file.
   The hero/slogan sync group is keyed by file **and** window.
4. **Numbers are rendered final on the server**; count-up (1500 ms everywhere — the mockup had
   1400 ms on Our Work) only runs for a number still off-screen at load. The mockup shipped
   "0" in the HTML.
5. **Digits:** Western in stats, counters, facet years and counts in Arabic — as the mockup
   has them. Arabic-Indic digits only where the mockup's Arabic sentences use them (the
   footer year, PR2).
6. **Testimonials follow the WAI-ARIA APG carousel**: a visible Pause/Play button beside the
   arrows (its label changes, so no `aria-pressed`); keyboard focus entering the carousel
   stops the rotation, and only Play restarts it (focus leaving does not); hover pauses it
   while the pointer is over; pauses off screen and with the page hidden; no auto-advance
   under reduced motion; `aria-live` off while rotating; RTL-aware arrow keys; white focus
   ring on Klein. Rendered `bare` (inside Our Work's section) it is a named group. The
   mockup had hover-pause only (and started Our Work's timer at page load).
7. **`.cta--light` stays white on hover** (work.html's behaviour). On projects/project the
   mockup's cascade turned it Cobalt under a Klein label (~2:1).
8. **An in-page "down" badge never slides sideways** — the mockup's Arabic join hero did.
9. **Kicker dot is Klein** even in a sky tag, white on a Klein band — as the mockup.
10. **`--dim-d` (white .60) maps to `--bs-muted`** (#a6adbf, contrast-gated).
11. **A non-numeric stat ("TBD") is `#6b7384`** (4.8:1 on white) — the mockup's `#C9CDD6` is 1.5:1.
12. **Card posters are decorative** (`alt=""`): the link's text names the project.
13. **Facet tags are links** everywhere (the mockup's catalog used script-driven buttons):
    they work without JS and can be opened in a new tab; in the catalogue the active value
    carries `aria-current` and its link clears it. A client not cleared for disclosure reads
    "Confidential client" / "عميل غير مُعلَن" (our Arabic — owner review), as text, never a
    link.
14. **The badge CTA uses the home shadow** (`.35` → cobalt `.45` on hover); the contact
    page's `.45`/`.55` pair is not carried.
15. **Split headings drop the blur** (compositor-only, Pillar 2), as the hero already does.
    Per word in both languages; 16 rungs of 38 ms (a class per word — no style attribute).
16. **Statistics section layouts** (`cards` default, `band`, `reach`, `proof`) are CMS content
    of the `statistics` section; the numbers and their per-page labels always come from the
    statistics table. `cards` keeps the pre-UI-v2 grid so existing compositions are unchanged.
    A standalone `proof` band carries the mockup's white `.proof` shell itself; only inside
    Our Work's section (`bare`) does it leave that to the section. Any number of counters
    wraps cleanly into further rows (the mockup's rules assumed exactly one row).
17. **Count-up numbers keep a fixed accessible value**: the animated digits are
    `aria-hidden` beside an `.sr-only` copy of the final value, so a screen reader reading
    ahead of the viewport never hears the "0" the count starts from; printing restores any
    counter still waiting.

## Our Work and All projects (PR10)

| Mockup | Site | Where |
| --- | --- | --- |
| work.html | `/portfolio` + `/ar/portfolio` — `CatalogPage.astro`, sections `workHero · proof · workIntro · projectGrid · clientsMarquee · cta` | `src/pages/portfolio/index.astro` |
| projects.html | `/portfolio/all` + `/ar/portfolio/all` (new) — sections `pageHead · projectCatalog · cta` | `src/pages/portfolio/all.astro` |
| `.hero--banner` + `.cap` | `MediaBanner.astro` (`.mbanner`, shared with the PR11 case study) + `WorkHero.astro` (`.work-cap`) | work.css |
| `.proof` (`.stats` + `.quotes`) | `ProofBand.astro` (`.proof`) = `StatBand` proof + `Testimonials` light, both `bare` | work.css |
| `.iw-sec` / `.iw` | `WorkIntro.astro` (`.work-intro`) + two `MediaFrame`s | work.css |
| `.work` / `.grid` / `.card` | `ProjectGrid.astro` (`.pgrid`), `ProjectCatalog.astro` (`.pcat`), `ProjectCard` | work.css |
| `BSCatalog` `.fb` filter bar | `FilterBar.astro` (`.fb`, `.fchip`, `.fpill` — the mockup's names) + `src/lib/client/catalogFilter.ts` | work.css |
| `.ap-head` | `PageHead.astro` (`.catalog-head` — `.page-head` is an older global utility) | work.css |
| catalog I18N | `src/lib/portfolio/filterText.ts` (one copy, server + browser) | |
| `.lead` | `LeadBand.astro`, now what the `cta` section type renders (CtaBand retired) | global.css |

Page CSS lives in the route sheet `public/styles/work.css`, linked through BaseLayout's new
`styles` prop (a closed list of names, so a typo fails `astro check`).

## Decisions (PR10)

18. **Filtering is server-side first.** Every control works without JavaScript: service
    chips, active pills and "Clear filters" are links; sector/client/year are `<select>`s
    in a GET form with an Apply button that only shows without JS. The enhancement applies
    the same controls in place — cards and pills are toggled with `hidden`, labels set with
    `textContent`, the URL follows with `history.replaceState` — and never builds markup or
    reads `location.search` (its state is the server's `data-state`, re-validated against
    the values the page carries). The mockup rebuilt the bar and grid with `innerHTML` on
    every change, which dropped keyboard focus to `<body>` and reflected `?year=` into the
    page (a DOM XSS). Here focus stays on the control used, or moves to the result count
    when that control disappears; the count is a polite live region.
19. **Only values a published project carries become a filter** (`parseFacets`); the first
    value of a repeated key wins. Any facet parameter — valid or not — makes the response
    `private, no-store`; only the bare URL is edge-cached (Tier A), and the canonical is
    always the bare page. Filtered URLs are never in the sitemap.
20. **Our Work filters the featured pool** (the mockup's `featuredOnly`), latest first (year
    desc, then catalogue order); the see-all button counts matches across the whole
    catalogue ("See all 3 matching projects"), as the mockup does, from a slug-only index on
    the button. All projects shows featured first, then catalogue order.
21. **Card titles are real headings** — h3 under Our Work's "Projects", h2 in All projects
    (the mockup's `span.card__t` left the grid with no structure). Card tags on Our Work
    filter Our Work itself (links carry `#projects`, so a no-JS click lands on the grid).
22. **Arabic counts follow the plural categories** (1 مشروع, 2 مشروعان, 3–10 مشاريع,
    11–99 مشروعًا, 100 مشروع) through `Intl.PluralRules`; the mockup writes "مشاريع" for
    every count. Owner sign-off pending (a deviation from decision 6's "verbatim").
23. **The banner caption is legible over any frame**: .45 glass (mockup .26), .7 meta (.58),
    a stronger bottom scrim under it, and no 4.5 s "rest" fade to half opacity. Contrast is
    gated for the worst case (a white frame) in `scripts/contrast-audit.mjs`. Its entrance
    and pulsing dot stop under reduced motion; the dot and the banner loop are EXC-007
    surfaces; the loop plays under EXC-009 and pauses once the banner is covered, when the
    caption also leaves the tab order.
24. **No parallax** on the banner (the mockup's JS translate on scroll) — dropped with Lenis;
    the banner is pinned (sticky) so the next section still slides over it.
25. **The filter chip count is .6 white** (mockup .45 = 4.4:1 at 11px); the `fb__lbl`, back
    link, lead and counts use `--bs-muted` for the mockup's `--dim-d` (decision 10).
26. **The All projects h1 has no scroll reveal** (the mockup's `.rv`): it is the page's
    likely LCP element, and text held at opacity 0 is not an LCP candidate until it fades in.
27. **A no-JS "Apply filters" / "طبّق الفلاتر" button** (ours — the mockup has no no-JS
    path; Arabic for owner review). The service filter survives an Apply through a hidden
    input.
28. **Our Work's h1 is visually hidden** ("Our Work" / "أعمالنا"), as in the mockup; All
    projects' h1 is its page head, and should an editor remove that section a hidden h1
    stands in.
29. **The intro frames are CMS media** (`workIntro.media[].mediaId`, keyed so the 0024 anon
    policy and `media_usage()` find them) with their clip windows (14.0–15.4 s, 17.4–18.3 s),
    decorative (`alt=""`) as in the mockup; a frame that does not resolve is left out, and
    with none the statement stands alone.
30. **Empty data hides cleanly**: no featured project → no grid; fewer than two Our Work
    counters → no numbers; no published quote (production) → no quotes; neither → no proof
    band at all; no project → no banner and no catalogue.
31. **Discovery lists use the case-study page's own loader and schema**
    (`getCaseStudyIndex`: the `getCaseStudy` select + `CaseStudyRowSchema`), so the sitemap
    and llms.txt never list a case study the page would 404 on. llms.txt names Our Work and
    All projects and lists case studies, with no counts.
32. **Metadata**: the English `<title>`/description are the mockup's own (the brand from
    identity); the Arabic is ours (`PAGE_META.portfolio` / `portfolioAll`) — owner review.
33. **The overlay header needs a dark opening.** Both pages use the transparent overlay
    header over their banner / black page head (the mockup's work-page scrim is carried by
    the banner's own top gradient); when the page does not open on one — no published
    project yet, or an editor hid or moved the head — it takes the solid bar instead of
    sitting white-on-white over the proof band. `data-hero` marks the element the header
    measures to turn solid.
34. **The `cta` section type renders LeadBand** (tag, outlined accent, `/contact#inquiry`,
    studio email from identity); CtaBand and its `.cta-band` CSS are retired. Any page still
    carrying a `cta` section (About's current default) now shows the Klein band.
