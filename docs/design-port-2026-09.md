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
| `.hero--banner` + `.cap` | `MediaBanner.astro` (`.mbanner`, shared with the PR11 case study) + `WorkHero.astro` (`.work-cap`) | banner.css (split out of work.css in PR11) |
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

## Case study (PR11)

| Mockup | Site | Where |
| --- | --- | --- |
| project.html `?p=<slug>` | `/portfolio/[slug]` + `/ar/portfolio/[slug]` — `CaseStudyPage.astro` + `loadCaseStudyPage` (one loader for both twins) | `src/components/case-study/`, `src/lib/portfolio/casePage.ts` |
| `.hero--banner` + `.cap` | `CaseBanner.astro` = `MediaBanner` + the `.work-cap` glass caption ("Case study") | banner.css |
| `.pt` / `.kw` / `.pt__meta` | `CaseTitle.astro` (`.cs-title`, `.cs-kw`) + `FacetTags` `case` | case-study.css |
| `.ov` / `.scope` / `.res` / `.ov__final` | `CaseOverview.astro` (`.cs-ov`, `.cs-scope`, `.cs-res`, `.cs-final` = `MediaFrame` `film`) | case-study.css |
| `.pq` | `CaseQuote.astro` (`.cs-quote` on `.klein-band`) | case-study.css |
| `.bd` / `.steps-bd` / `.bdi` | `CaseBreakdown.astro` (`.cs-bd`, `.cs-bdi`) | case-study.css |
| `.gal` + `GAL_PATTERN` | `CaseGallery.astro` (`.cs-gal`) + `galleryLayout()` (server-side) | case-study.css |
| `.lb` | `Lightbox.astro` (`dialog.lightbox`) + `src/lib/client/lightbox.ts` | case-study.css |
| `.nx` | `NextProject.astro` (`.cs-next`) + `nextProject()` | case-study.css |
| `.lead` | `LeadBand` (unchanged) | global.css |

## Decisions (PR11)

35. **An unknown slug is a real 404** (status 404; the Arabic 404 page under `/ar`) — the
    mockup rendered The Rider for any slug, and cloned The Rider's whole body into the six
    projects that had no written case study. Here a project renders only its own data, and
    every part hides when it has none: a card-only project reads banner → title → facets →
    next → lead band. The page and the discovery index (sitemap, llms.txt) share one parse
    path (`parseCaseStudies`), so neither lists a slug that answers 404.
36. **Banner fallback**: the hero frame and loop, else the card poster and preview (the
    mockup's own fallback). With no image at all there is no banner; the black title band
    opens the page, carries `data-hero` for the overlay header, and its h1 drops the reveal
    (it may be the LCP element).
37. **The h1 is the project's name**; its type lives in the keyword chips, which fall back
    to the type alone when none are authored (the mockup's rule). The chips are a list (its
    accessible name "Keywords" / "الكلمات المفتاحية" is ours — owner review). Facets are
    links into All projects, "Industry" = the sector. The back link keeps the mockup's
    target, Our Work's grid (`/portfolio#projects`).
38. **Overview headings are real h2s** (the mockup's were divs). Each block hides when
    empty; the sanitised `body_html` cache, when a project has one, follows the summary.
39. **The final film is a muted in-view loop** (30 % visible, the mockup's threshold) and
    never plays on touch, under reduced motion or with Save-Data. The mockup's in-place
    "Sound on" toggle is not shipped: sound, captions (WCAG 1.2.2) and a pause control
    arrive with the Stream player (KAN-20). **No Stream facade is rendered on the case
    study** — nothing third-party loads, so there is nothing to consent-gate today; the
    player that replaces the loop must go through `hasConsent` (recorded as a KAN-20
    prerequisite in EXC-009).
40. **The quote is attributed to the person** — `author_name` + "Title, Company" — where the
    mockup overwrote the name with the client company ("Client A"). Photo, else initials
    (the shared helper skips the Arabic article: "اسم العميل" → "اع"). Only the project's
    own PUBLISHED testimonial is shown; with none (production today) the band is absent.
41. **Stills are content, so alt text is required**: a breakdown or gallery still is shown
    only when it can be described in both languages (a caption, or an EN + AR alt), else it
    is dropped. Its alt is its own description, else its caption. The mockup used the
    caption for breakdown alts and `alt=""` in gallery buttons named "01".
42. **Stills are links to their full-size image** (1600 px WebP): without JS, or with a
    modified click, they open the image. The viewer is a native modal `<dialog>`: the page
    behind is inert, focus goes to Close, Tab wraps inside, Escape and a backdrop click
    close, focus returns to the still; labels are localised (ours in Arabic — owner review);
    the counter is a polite live region; the page does not scroll behind it; its fade-in is
    killed under reduced motion. **RTL keeps the buttons' meaning** — Previous sits at the
    inline start with a mirrored arrow, and ArrowLeft means "next" — where the mockup kept
    the buttons in place and swapped what they did (its "Previous" went forwards).
43. **The gallery count follows the Arabic plural categories** (01 لقطة, 02 لقطتان, 03–10
    لقطات, 11–99 لقطةً); the mockup wrote "09 لقطة". Owner sign-off with decision 22.
44. **The gallery rhythm is server-rendered** (`galleryLayout`, including the phone rule
    that stretches a half left alone on its row). The stills touch edge to edge, so the
    focus ring is drawn inside the still (white with a dark keyline), not as an outline the
    next still would paint over.
45. **Next project** = the editor's pick (`next_portfolio_id`) when it is another published
    project, else the next in catalogue order, wrapping (the mockup's rule). The band is one
    link named "Next project: <name>". A .4 black scrim over the poster and a .85 kicker
    (the mockup's .75, no scrim): at its hover opacity over a bright frame the kicker fell to
    ~2.4:1. Gated in `scripts/contrast-audit.mjs` (`nxWorst`).
46. **Structured data**: an extended CreativeWork — `image` (the banner frame, 1200 px JPEG,
    absolute), `dateModified` (the row's `updated_at`), `dateCreated` (the year),
    `keywords`, `genre` (the type), `about` (the sector), `inLanguage` — and a breadcrumb
    Home › Our Work › name. **No Review/AggregateRating**: a client quote on our own page is
    not an independent review. og:image falls back to the same frame when SEO set none.
47. **Metadata**: the title is the mockup's own `document.title` — "<name> | <type>" under
    the brand template; the description is the teaser, else the summary (strictly in the
    page's language), else the mockup's generic line (`CASE_STUDY_META`; the Arabic is ours
    — owner review).
48. **Cache**: Tier A, tagged `portfolio:<slug>`, `portfolio:all` (the next project's card),
    `sectors:all`, `clients:all`, `services:all`, `testimonials:all`.
49. **The banner's CSS is its own route sheet** (`banner.css`), linked by Our Work, All
    projects and the case study, so the case study does not load the catalogue's CSS and
    Our Work does not load the case study's.
50. **Dropped with Lenis, as on Our Work**: the banner parallax, the caption's rest fade,
    the hero loop ignoring reduced motion. Digits stay Latin in Arabic for scope numbers,
    result values, the film length and counts (decision 5); result values are LTR-isolated
    so "+XX%" keeps its sign in front.
51. **Every part is its own error boundary** (`SectionBoundary`): a failing part leaves an
    empty placeholder, never a 500.
52. **The lead band paints over a pinned banner** (`.mbanner ~ .lead-band { z-index: 4 }`,
    banner.css — the mockup's `.lead` z-index). The banner stays stuck at the top of its
    page, and the lead band — shared chrome with no z-index of its own — slid UNDER it as it
    scrolled up. This also fixes Our Work, where PR10 shipped the same stacking.
