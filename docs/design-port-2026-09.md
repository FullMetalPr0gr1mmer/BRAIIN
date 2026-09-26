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

## Home (PR7)

| Mockup | Site | Where |
|---|---|---|
| `.sw-sec` / `.sw-top` / `.sw-state` / `.sw-grid` / `.sw-foot` | `SelectedWork.astro` (`.sel-work`, `__top`, `__state`, `__grid`, `__foot`) | section type `selectedWork` |
| `.sw-hero.media` + `.sw-copy` | `MediaFrame` (`mf--feature`, in-view clip) + `.sel-work__copy` + `FacetTags` (`facets--light`) | featured project |
| `.sw-card` | `ProjectCard` `home` variant | the two cards |
| `.nums` | `StatBand` `band` (`statistics` section, `placement: home`) | `#numbers` |
| `.tm` | `Testimonials` `klein` via `TestimonialsSection.astro` | section type `testimonials`, `#testimonials` |
| `.form` / `.field` / `.btn` / `.form__ok` | `ContactForm fields="compact"` (`.contact-form--compact`, `.cta--trail`, `.form-status.is-ok`) + `src/lib/client/formErrors.ts` | `#contact` |
| clients `#work` | `ClientsMarquee` `#clients`, from the `clients` table | — |

## Decisions (PR7)

18. **Home order is the design's** — hero, clients, selected work, numbers, testimonials,
    services, why us, slogan, contact, social — in `DEFAULT_HOME_SECTIONS` and in the
    seeded composition (`supabase/seed-data/50-home.json`, seeded only while the home page
    has no sections). Every data band hides when its table is empty: no marquee without a
    cleared client, no Selected work without a featured project, no numbers under
    `minItems`, no testimonials without a published quote (production's sample quotes stay
    unpublished).
19. **The hero CTA goes to `#selected-work` only when that band will render**
    (`homeHeroCtaHref`): with nothing featured, or the band hidden/removed, it goes to
    `/portfolio` — a dead in-page anchor is a broken button. The route decides and passes
    it as route data; the accent excludes the trailing `*` (`splitTrailingMark`); the
    accent stays **cobalt** and the scrim stays (the mockup's Klein measures ~2.0:1 on
    black — PR6 deviation list).
20. **No code fallback for the client marquee.** It named eight real brands from code
    whenever the table was empty — a claim no editor could withdraw. The names now come
    only from `clients` rows that are `visible` (the disclosure permission, enforced by
    RLS) and `show_in_marquee`, in each locale's spelling (`partner_logos` held one English
    name per row). "Since 2019" is the identity's `founded_year` (Arabic-Indic in Arabic,
    as the design writes it); no year, no note. The partner-logos admin is retired (its
    table stays until the contract migration; `export-backup` still dumps it).
21. **Selected work picks among the featured projects only.** Default: the first by
    `sort_order` is the featured project, the next two the cards; `featuredSlug` /
    `cardSlugs` re-pick, and a stale slug falls back rather than emptying the band. The
    featured block shows the project's **name on its own line, then its teaser** (the
    lead contract: blurb = `teaser ?? summary`). The mockup's home-only sentence ("*The
    Rider* is a launch film… by one team that never handed it off.") is not carried: the
    teaser is catalogue copy that does not open with the name, and the section schema has
    no blurb override. The numbered lines are an `<ol>` (the numbers are `aria-hidden`).
    "See the project" carries the project name for screen readers (WCAG 2.4.4).
22. **The home form is the design's five fields** (name, email, company, service,
    message) plus the PDPL consent checkbox and the honeypot, posting `kind=contact`. The
    design's copy is verbatim (its Saudi-voice Arabic, "Send message", the success line);
    validation and system messages stay MSA. The design's form showed "sent" whatever
    happened and marked errors with a red border only: here every outcome is real
    (`statusFromHttp`: sent, invalid, rate-limited, unavailable, error), each bad field
    gets `aria-invalid`, a text message and `aria-describedby`, focus goes to the first,
    and a server 422 now names the refused schema keys (never their values, never the
    honeypot) so those fields are marked too. On success the fields give way to the
    confirmation panel, which takes focus. Error text uses `--bs-err-soft` (the audited
    token on black). The consent label says "inquiry" in both forms.
23. **The contact-form contract is one list** (`src/lib/forms/contactPayload.ts`): the
    fields per variant (the markup renders from it) and their LeadInputSchema keys.
    `tests/lib/contactForm.spec.ts` asserts every key it can post is a schema key — the
    schema is non-strict and would drop anything else in silence.
24. **Testimonials section**: `intervalMs` (4–15 s) reaches the carousel as
    `data-interval`; everything else is PR6's APG carousel. Advanced-only in the editor,
    with the accent ranges, `cardSlugs` and the Selected work `button` (no typed field
    kind for a list of slugs or a {label, href} pair yet).
25. **Home stacking**: the hero is sticky under the whole page, so every band after it
    paints above it — the PR6 bands (`.sb--band`, `.tm--klein`) gain `z-index: 4` in the
    home block, as `.sel-work` has.
26. **Home LCP**: the intro logo's entrance starts at **opacity .01, not 0**. Chromium
    records no LCP candidate for an element painted at opacity 0 and does not record it
    when the fade brings it in (measured in Chromium: from 0 → no entry; from .01 → the
    `<img>` at first paint). A returning visitor therefore had no LCP entry at all. At
    .01 the logo is still invisible through the FOUC guard, so the intro is unchanged.
    Trade-off left as is: on a first visit at narrow widths the consent banner's text
    (shown by script) can out-size the 46vw logo and become the LCP — that is a real
    paint the visitor sees, and hiding or pre-painting the PDPL banner to win a metric
    would be the wrong trade. The headline letters are NOT given the same treatment: they
    arrive after the plate by design, and reporting them at first paint would be gaming
    the metric.
27. **Chrome fixes shipped with the home port** (verified on production): at ≤900px the
    open menu no longer shows the key link a second time (both copies carried
    `aria-current` on /contact); the consent banner is localized (Arabic copy in MSA,
    `/ar/cookie-policy`); unmatched `/ar/*` URLs answer the Arabic 404
    (`src/pages/ar/[...path].astro`, the lowest-priority rest route), and a 404's
    language switch goes to the other locale's home instead of linking to itself.

## About (PR8)

| Mockup | Site | Where |
|---|---|---|
| `.who` + `splitWords()` + `[data-clip]` | `AboutWho.astro` (`.about-who`, section type `aboutWho`) + `SplitHeading` + `MediaFrame` (`mf--who`) | About |
| `.lead-team` / `.lt__*` / `.person*` | `LeadershipSlider.astro` (`.leaders*` / `.leader*`, section type `leadership`) + `src/lib/client/slider.ts` | About |
| `.reach` / `.rs*` | `StatBand` `sb--reach` (statistics section `{variant:'reach', placement:'about'}`) | About |
| `.follow` | `SocialStrip` `variant="klein"` (`.social-strip--klein` + `.klein-band`) | About |

Page-only CSS is `public/styles/about.css`, linked through BaseLayout's new `styles` prop (file
names only, validated `^[a-z0-9-]+\.css$`). The Klein social variant stays in global.css:
`social` is a section type any page can compose.

28. **The "who" poster is the LCP element**: eager, `fetchpriority="high"`, real dimensions,
    and never reveal-gated (the mockup faded it in with `.rv` and `loading="lazy"`). Its alt
    is empty, as in the mockup (a showreel frame beside the manifesto). The code default
    carries no media — the poster (the p2 still) and the 6.2–7.9 s clip are seeded section
    content — so an unseeded page renders the section text-only rather than falling back to a
    hard-coded image.
29. **Leadership is its own section type (`leadership`)**, not a `team` variant: `team` stays
    the table-backed author grid with no content, and the slider's copy (tag, heading,
    accent, text) is typed content like every other UI v2 band. The people are
    `team_members.is_leadership`, injected by the route as `data`.
30. **A card links to LinkedIn only when a URL exists**; otherwise it is plain content with no
    tab stop (the mockup's `tabindex="0"` div was a focus stop that did nothing). A linked
    card announces "LinkedIn profile (opens in a new tab)" / "حساب لينكدإن (يفتح في تبويب
    جديد)" (the Arabic suffix is ours — system text, owner review); the badge is
    `aria-hidden` and the portrait `alt=""`, since the name is the card's text. The URL is
    re-checked against 0023's LinkedIn shape on read (`toLeader`), because it renders into an
    `href`. `rel="noopener noreferrer"`.
31. **Slider controls**: Previous/Next are localized ("السابق" / "التالي" — the mockup left
    them in English) and go `aria-disabled` at the ends instead of `disabled`, so keyboard
    focus is not dropped to `<body>`. The track is a named, focusable region (a scroller
    with no links must still be reachable), and Arrow keys on it step one card in the
    reading direction. The counter is `aria-hidden`, Western digits, `dir="ltr"` (so it
    reads "01 / 06" in Arabic, not "06 / 01"). Without JS the row is a native scroll-snap
    scroller and the chrome stays hidden, as it does whenever the cards fit.
32. **Leadership motion is compositor-only**: the progress bar is `translateX` + `scaleX` of
    a full-width bar (the mockup animated `margin` and `width`); grayscale → colour is an
    opacity fade of a `mix-blend-mode: saturation` layer (the mockup transitioned `filter`);
    the Klein underline is `scaleX`. The name's sky colour and the silhouette's shade change
    instantly on hover — no colour transition. Under reduced motion the photo zoom is
    dropped and every scroll is instant.
33. **Our reach shows the counters marked for About**, under their About labels
    (`placement_labels.about`); "14 crafts" is home/Our Work only, as in the mockup.
34. **Follow the studio** reads the handles from the public identity (the mockup's inline
    catalog), and its copy is the Klein variant's built-in table, verbatim. The outlined
    accent is kept in both languages (the mockup's); forced-colors fills it instead. The
    Arabic outline over joined glyphs is flagged for the PR14 visual review.
35. **Certifications and the CTA band are dropped from the About composition** (the mockup
    has neither); both remain section types an editor can add back.
36. **Person JSON-LD names only the leaders the page shows** (none when the leadership
    section is hidden), with `jobTitle` and `sameAs` (LinkedIn). The seeded placeholders are
    drafts in production, so no placeholder person is ever published there; dev/CI/staging
    carry their "Name Surname" nodes.
37. **The About manifesto is the About page's own copy**, verbatim (it differs from the home
    "why us" columns: "between vendors", no "Arabic, English, or…" sentence), and the h1's
    accent includes the final period, as the mockup's `<em>` does.

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

38. **Filtering is server-side first.** Every control works without JavaScript: service
    chips, active pills and "Clear filters" are links; sector/client/year are `<select>`s
    in a GET form with an Apply button that only shows without JS. The enhancement applies
    the same controls in place — cards and pills are toggled with `hidden`, labels set with
    `textContent`, the URL follows with `history.replaceState` — and never builds markup or
    reads `location.search` (its state is the server's `data-state`, re-validated against
    the values the page carries). The mockup rebuilt the bar and grid with `innerHTML` on
    every change, which dropped keyboard focus to `<body>` and reflected `?year=` into the
    page (a DOM XSS). Here focus stays on the control used, or moves to the result count
    when that control disappears; the count is a polite live region.
39. **Only values a published project carries become a filter** (`parseFacets`); the first
    value of a repeated key wins. Any facet parameter — valid or not — makes the response
    `private, no-store`; only the bare URL is edge-cached (Tier A), and the canonical is
    always the bare page. Filtered URLs are never in the sitemap.
40. **Our Work filters the featured pool** (the mockup's `featuredOnly`), latest first (year
    desc, then catalogue order); the see-all button counts matches across the whole
    catalogue ("See all 3 matching projects"), as the mockup does, from a slug-only index on
    the button. All projects shows featured first, then catalogue order.
41. **Card titles are real headings** — h3 under Our Work's "Projects", h2 in All projects
    (the mockup's `span.card__t` left the grid with no structure). Card tags on Our Work
    filter Our Work itself (links carry `#projects`, so a no-JS click lands on the grid).
42. **Arabic counts follow the plural categories** (1 مشروع, 2 مشروعان, 3–10 مشاريع,
    11–99 مشروعًا, 100 مشروع) through `Intl.PluralRules`; the mockup writes "مشاريع" for
    every count. Owner sign-off pending (a deviation from decision 6's "verbatim").
43. **The banner caption is legible over any frame**: .45 glass (mockup .26), .7 meta (.58),
    a stronger bottom scrim under it, and no 4.5 s "rest" fade to half opacity. Contrast is
    gated for the worst case (a white frame) in `scripts/contrast-audit.mjs`. Its entrance
    and pulsing dot stop under reduced motion; the dot and the banner loop are EXC-007
    surfaces; the loop plays under EXC-009 and pauses once the banner is covered, when the
    caption also leaves the tab order.
44. **No parallax** on the banner (the mockup's JS translate on scroll) — dropped with Lenis;
    the banner is pinned (sticky) so the next section still slides over it.
45. **The filter chip count is .6 white** (mockup .45 = 4.4:1 at 11px); the `fb__lbl`, back
    link, lead and counts use `--bs-muted` for the mockup's `--dim-d` (decision 10).
46. **The All projects h1 has no scroll reveal** (the mockup's `.rv`): it is the page's
    likely LCP element, and text held at opacity 0 is not an LCP candidate until it fades in.
47. **A no-JS "Apply filters" / "طبّق الفلاتر" button** (ours — the mockup has no no-JS
    path; Arabic for owner review). The service filter survives an Apply through a hidden
    input.
48. **Our Work's h1 is visually hidden** ("Our Work" / "أعمالنا"), as in the mockup; All
    projects' h1 is its page head, and should an editor remove that section a hidden h1
    stands in.
49. **The intro frames are CMS media** (`workIntro.media[].mediaId`, keyed so the 0024 anon
    policy and `media_usage()` find them) with their clip windows (14.0–15.4 s, 17.4–18.3 s),
    decorative (`alt=""`) as in the mockup; a frame that does not resolve is left out, and
    with none the statement stands alone.
50. **Empty data hides cleanly**: no featured project → no grid; fewer than two Our Work
    counters → no numbers; no published quote (production) → no quotes; neither → no proof
    band at all; no project → no banner and no catalogue.
51. **Discovery lists use the case-study page's own loader and schema**
    (`getCaseStudyIndex`: the `getCaseStudy` select + `CaseStudyRowSchema`), so the sitemap
    and llms.txt never list a case study the page would 404 on. llms.txt names Our Work and
    All projects and lists case studies, with no counts.
52. **Metadata**: the English `<title>`/description are the mockup's own (the brand from
    identity); the Arabic is ours (`PAGE_META.portfolio` / `portfolioAll`) — owner review.
53. **The overlay header needs a dark opening.** Both pages use the transparent overlay
    header over their banner / black page head (the mockup's work-page scrim is carried by
    the banner's own top gradient); when the page does not open on one — no published
    project yet, or an editor hid or moved the head — it takes the solid bar instead of
    sitting white-on-white over the proof band. `data-hero` marks the element the header
    measures to turn solid.
54. **The `cta` section type renders LeadBand** (tag, outlined accent, `/contact#inquiry`,
    studio email from identity); CtaBand and its `.cta-band` CSS are retired. Any page still
    carrying a `cta` section (About's current default) now shows the Klein band.

## Contact (PR9)

| Mockup | Site | Where |
|---|---|---|
| `.hero--contact` | `Hero` with `withHeroPreset(…, 'contact')` → `.hero--banner` (route data: banner, `#inquiry`, clip 6.2–7.9 s) | `/contact` hero |
| hero `.cta.cta--down` (icon first) | `Cta.astro` `.cta--badge.cta--down.hero__cta` | hero |
| `.inquiry` + `.sec__head` | `ContactInquiry.astro` (`.contact-inquiry`, `.sec-head`, `AccentText`) | `#inquiry` |
| `.form` / `.field` / `.form__foot` / `.form__ok` | `ContactForm fields="full"` (`.contact-form--full`, badge submit, `.form-status.is-ok`) + `formErrors.ts` | `#inquiry` |
| `.touch` / `.tbox` / `.tbox__ico` | `ContactChannels.astro` (`.contact-touch`, `.touch-card`, `.touch-card__ico`) | channels |
| `.social--joined` | `SocialStrip joined` (`.social-strip--joined`) | channels |
| `.faq` / `.qa` | `FaqAccordion.astro` (`.faq-section`, native `<details class="faq-item">`) | `#faq` |

## Decisions (PR9)

55. **The contact page is CMS-composed** (`pages` slug `contact`, seeded by
    `supabase/seed-data/52-contact.json` while the page has no sections), with three route
    guarantees on top: `withHeroPreset('contact')`, `ensureContactInquiry` and
    `withContactData` (services as route data). This fixes the production bug where the
    hero rendered the HOME headline and its "See our work" button (and jumped to the form).
    The preset is code-only and never stored: its copy (the design's, verbatim) is a
    default under authored content; its layout — the banner, the `#inquiry` target, the
    loop window — is route `data` the CMS cannot change. An authored headline never
    inherits the preset's accent indices (they count the preset's words). A banner hero
    never shows the intro plate, whatever its content says. The page gains its `<main>`.
56. **Hero loop window 6.2–7.9 s** via `data-clip-start/end` on the hero media (lazyVideo's
    windowed loop, EXC-009); the design's `scale(1.1)` + `object-position: center 42%` are
    kept. Its `inset: -10%` overscan is not: it existed only for the JS parallax the port
    drops. The accent stays **cobalt** (the design's Klein is ~2:1 on the dark video — the
    PR6 deviation), and the scrim stays.
57. **The full form is the design's seven fields** (name, email, company, service, budget,
    deadline, message) plus the PDPL consent checkbox and the honeypot, posting
    `kind=project_inquiry`. Phone and the timeline select are gone (the schema still accepts
    `phone` and the legacy `timelineBand` for cached pages). The deadline is free text,
    `maxlength=120`, posted as `timelineText` (encrypted into `timeline_text_enc`,
    Admin/Developer only). Budget options are `BUDGET_BAND_LABELS` — the design's bands and
    its Arabic-Indic digits — with "Prefer to discuss" as the empty option; legacy bands are
    accepted on input, never offered. Outcomes, per-field errors and the sent state are
    PR7's (`formErrors.ts`); the design's form showed "sent" whatever happened.
58. **Service options are the published services' titles**, valued by slug — not the
    design's static list, which differs from the CMS in six labels ("Animation" vs
    "Animations"; five Arabic titles). Matching the design is a content edit in
    /admin/services, not code.
59. **Section heads are real `<h2>`s** named by `aria-labelledby`, with the accent as a word
    range (`AccentText`) — never an HTML string. `contactInquiry`, `contactChannels` and
    `faq` now take CMS copy overrides (strict schemas; tag, heading, accent, lead, and the
    form note / confirmation / submit label, and the card labels and notes). The FAQ's
    questions and answers stay code-owned: they are also the FAQPage JSON-LD.
60. **The FAQ is the design's dark band** — and that is the contrast fix verified on
    production: on the old paper band its sky kicker and heading accent measured 2.56:1
    (WCAG 1.4.3). Sky is used only on the black bands (8.2:1); the paper channels band
    takes Klein (10.6:1); `scripts/contrast-audit.mjs` asserts the pairs and the contact e2e
    measures every kicker and accent against its own band. Questions turn sky on hover and
    when open, as designed. The design animated the panel height (layout); here the panel
    opens natively and the answer rises in (transform + opacity, in the reduced-motion
    invariant). The FAQPage JSON-LD is emitted only while the FAQ band renders.
61. **The Arabic FAQ is the design's Saudi-voice copy, verbatim** (owner decision 6),
    replacing the MSA rewrite; the English was already verbatim. Answer 5 ("one of the
    fourteen") is tied to the service count — flagged for the owner, kept verbatim.
62. **Channel cards carry the design's icons**, Klein labels and 700-weight values; the hover
    label/note stay at .88 white (the design's .8 is 4.36:1 on the gradient). The WhatsApp
    card renders only for a valid E.164 number in the identity (`whatsappChannel`, checked
    again on read) — the design's `wa.me/9665XXXXXXXX` never ships. The lead "No form, no
    gatekeeping." is kept verbatim although it sits under a form (flagged, design copy).
63. **The joined social strip keeps the design's inset rule** (the gutter is a margin, so
    the line is inset too) and drops the standalone strip's bottom padding — the
    `.contact-touch` padding ends the band, as the design's `.social--joined` (not a
    `.social`) does. The full form fills the section wrap with no margin of its own
    (`max-width: none; margin-block: 0`), as the design's `.form`: the shared 60rem cap
    and 1.5rem margins had left it ~200px short of the head at ≥1280px. The contact-only always-on `.nav::before` gradient is not
    carried: the overlay header and the hero scrim already hold the nav's contrast.
