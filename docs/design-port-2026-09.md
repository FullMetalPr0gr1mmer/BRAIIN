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

1. **No clip autoplay on touch** (EXC-009; an EXC-007 surface until R3-7 closed it): touch
   devices see the poster. The mockup
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
    it as route data; the accent excludes the trailing `*` (`splitTrailingMark`), and the
    `*` is its own word span with no space before it (`.word--mark`, amended in decision
    83), so it wraps alone as the design's does; the accent stays **cobalt** and the scrim stays (the mockup's Klein measures ~2.0:1 on
    black — PR6 deviation list).
20. **No code fallback for the client marquee.** It named eight real brands from code
    whenever the table was empty — a claim no editor could withdraw. The names now come
    only from `clients` rows that are `visible` (the disclosure permission, enforced by
    RLS) and `show_in_marquee`, in each locale's spelling (`partner_logos` held one English
    name per row). The track runs `direction: ltr` as the design's does (the loop maths
    assume it; each Arabic name is its own bidi run), flipping back to RTL only in the
    reduced-motion static list. "Since 2019" is the identity's `founded_year` (Arabic-Indic
    in Arabic, as the design writes it); no year, no note. The partner-logos admin is retired (its
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
    token on black). The consent label says "inquiry" in both forms. The selects carry the
    design's chevron (`appearance: none`, mirrored in RTL), but unlike the mockup it stays
    visible on focus (the focus rule sets `background-color`, not the shorthand). The
    invalid-form message names no direction ("the marked fields") — the status line renders
    below every field it refers to (WCAG 1.3.3).
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
    hard-coded image. Its in-view clip waits for `load` before it is observed
    (`data-clip-after-load`, set by MediaFrame on a `priority` in-view frame), so the
    showreel's bytes never compete with the poster — the rule MediaBanner and the hero apply.
    The page's one font preload is the face its h1 renders in: `/ar/about` preloads Almarai
    **700** (the weight-600 h1 resolves to it), not Home's 800 — preloading 800 left the 700
    face to swap in late and shift the split heading (CLS 0.14 > 0.1). BaseLayout `heroFace`;
    docs/fonts.md step 3.
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
    opacity fade of a `mix-blend-mode: saturation` layer (the mockup transitioned `filter`)
    — over a **photo only** (`.leader__ph--photo`; amended 2026-09-27): the mockup greys the
    `<img>` alone, and the layer over the whole frame had turned the photo-less card's
    slate-blue gradient and silhouette grey, then blue on hover;
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
36. **Person JSON-LD names only the real leaders the page shows** (none when the leadership
    section is hidden), with `jobTitle` and `sameAs` (LinkedIn). A placeholder row
    (`is_placeholder`) never emits a Person node — in any environment, including production
    once the 0027 override and runbook §6c publish the seeded "Name Surname" leaders: their
    cards show (the owner's decision), but structured data is read as fact about real people
    at the studio. The legacy `team` grid's Person nodes follow the same rule.
37. **The About manifesto is the About page's own copy**, verbatim (it differs from the home
    "why us" columns: "between vendors", no "Arabic, English, or…" sentence), and the h1's
    accent includes the final period, as the mockup's `<em>` does.

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

38. **Filtering is server-side first.** Every control works without JavaScript: service
    chips, active pills and "Clear filters" are links; sector/client/year are `<select>`s
    in a GET form with an Apply button that only shows without JS. The enhancement applies
    the same controls in place — cards and pills are toggled with `hidden`, labels set with
    `textContent`, the URL follows with `history.replaceState` — and never builds markup or
    reads `location.search` (its state is the server's `data-state`, re-validated against
    the values the page carries). The mockup rebuilt the bar and grid with `innerHTML` on
    every change, which dropped keyboard focus to `<body>` and reflected `?year=` into the
    page (a DOM XSS). Here focus stays on the control used, or moves to the result count
    when that control disappears (decided from the control the visitor operated, not
    `document.activeElement`: Chromium blurs a pill the moment its own `hidden` is set,
    and Safari never focuses a clicked link); the count is a polite live region. An
    active pill is named by its visible text first, then the action — "Service:
    Branding, remove filter" / "الخدمة: الهوية البصرية، إزالة الفلتر" (WCAG 2.5.3 Label in
    Name; the mockup had no name, and "Remove filter: Branding" dropped the facet word a
    speech-input user sees).
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
    and pulsing dot stop under reduced motion; the dot and the banner loop stop with the
    header's motion switch (R3-7); the loop plays under EXC-009 and pauses once the whole
    banner is covered. The
    caption leaves paint and the tab order earlier — as soon as the next section's edge
    passes the caption's own top, i.e. once it is entirely painted over (WCAG 2.4.11
    Focus Not Obscured); measured against the whole banner, it stayed focusable while
    hidden for most of the banner's height.
44. **No parallax** on the banner (the mockup's JS translate on scroll) — dropped with Lenis;
    the banner is pinned (sticky) so the next section still slides over it. **Not pinned on
    a viewport shorter than 480px** (400% zoom, a landscape phone): the banner's 400px floor
    would never scroll past, so its bottom-anchored caption — the only place the teaser,
    client and year appear — was covered before it was ever seen (WCAG 1.4.10 Reflow;
    `banner.css`). The contact `.hero--banner` has the same pre-existing root cause
    (global.css, from main) and is left for a follow-up.
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
    band at all; no project → no banner and no catalogue. The banner also needs its
    project's poster (`bannerCard`): a clip alone opened the page on a blank dark block
    (and never plays under reduced motion or Save-Data). The intro's "See the projects"
    follows the home CTA's rule (decision 19, `workIntroLinkHref`): `#projects` only when
    the grid renders, else All projects, and no link at all while nothing is published.
51. **Discovery lists use the case-study page's own loader and schema**
    (`getCaseStudyIndex`: the `getCaseStudy` select + `CaseStudyRowSchema`), so the sitemap
    and llms.txt never list a case study the page would 404 on. llms.txt names Our Work and
    All projects and lists case studies, with no counts.
52. **Metadata**: the English `<title>`/description are the mockup's own (the brand from
    identity); the Arabic is ours (`PAGE_META.portfolio` / `portfolioAll`) — owner review.
53. **The overlay header needs a dark opening.** Both pages use the transparent overlay
    header over their banner / black page head (the mockup's work-page scrim is carried by
    the banner's own top gradient); when the page does not open on one — no published
    project (or none with a poster: the route asks `bannerCard`, the same call WorkHero
    makes), or an editor hid or moved the head — it takes the solid bar instead of
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

64. **An unknown slug is a real 404** (status 404; the Arabic 404 page under `/ar`) — the
    mockup rendered The Rider for any slug, and cloned The Rider's whole body into the six
    projects that had no written case study. Here a project renders only its own data, and
    every part hides when it has none: a card-only project reads banner → title → facets →
    next → lead band. The page and the discovery index (sitemap, llms.txt) share one parse
    path (`parseCaseStudies`), so neither lists a slug that answers 404.
65. **Banner fallback**: the hero frame and loop, else the card poster and preview (the
    mockup's own fallback). With no frame there is no banner, even when a clip exists (a clip
    alone would pin a blank dark block until the loop mounts; Our Work's `bannerCard` follows
    the same rule); the black title band
    opens the page, carries `data-hero` for the overlay header, and its h1 drops the reveal
    (it may be the LCP element).
66. **The h1 is the project's name**; its type lives in the keyword chips, which fall back
    to the type alone when none are authored (the mockup's rule). The chips are a list (its
    accessible name "Keywords" / "الكلمات المفتاحية" is ours — owner review). Facets are
    links into All projects, "Industry" = the sector. The back link keeps the mockup's
    target, Our Work's grid (`/portfolio#projects`).
67. **Overview headings are real h2s** (the mockup's were divs). Each block hides when
    empty; the body, when a project has one, follows the summary. **It is rendered at
    render time from the Tiptap JSON (`body`) by the allowlist renderer** (`renderBody`,
    `src/lib/data/portfolio.ts`), not read from the `body_html` cache: the database accepts
    that cache from a direct PostgREST / `rpc/save_portfolio` write that skips the admin
    API's sanitiser, and Pillar 1 is "sanitised on write AND render". The cost lands on an
    edge-cache miss only. BlogDetail/ServiceDetail still emit their cache — follow-up.
68. **The final film is a muted in-view loop** (30 % visible, the mockup's threshold) and
    never plays on touch, under reduced motion or with Save-Data. The mockup's in-place
    "Sound on" toggle is not shipped: sound and captions (WCAG 1.2.2) arrive with the
    Stream player (KAN-20); the pause control is the header's motion switch (R3-7). **No Stream facade is rendered on the case
    study** — nothing third-party loads, so there is nothing to consent-gate today; the
    player that replaces the loop must go through `hasConsent` (recorded as a KAN-20
    prerequisite in EXC-009).
69. **The quote is attributed to the person** — `author_name` + "Title, Company" — where the
    mockup overwrote the name with the client company ("Client A"). Photo, else initials
    (the shared helper skips the Arabic article: "اسم العميل" → "اع"). Only the project's
    own PUBLISHED testimonial is shown; with none (production today) the band is absent.
70. **Stills are content, so alt text is required**: a breakdown or gallery still is shown
    only when it can be described in both languages (a caption, or an EN + AR alt), else it
    is dropped. Its alt is its own description, else its caption. The mockup used the
    caption for breakdown alts and `alt=""` in gallery buttons named "01".
71. **Stills are links to their full-size image** (1600 px WebP): without JS, or with a
    modified click, they open the image. The viewer is a native modal `<dialog>`: the page
    behind is inert, focus goes to Close, Tab wraps inside, Escape and a backdrop click
    close, focus returns to the still; labels are localised (ours in Arabic — owner review);
    the counter is a polite live region; the page does not scroll behind it; its fade-in is
    killed under reduced motion. **RTL keeps the buttons' meaning** — Previous sits at the
    inline start with a mirrored arrow, and ArrowLeft means "next" — where the mockup kept
    the buttons in place and swapped what they did (its "Previous" went forwards).
72. **The gallery count follows the Arabic plural categories** (01 لقطة, 02 لقطتان, 03–10
    لقطات, 11–99 لقطةً); the mockup wrote "09 لقطة". Owner sign-off with decision 42.
73. **The gallery rhythm is server-rendered** (`galleryLayout`, including the phone rule
    that stretches a half left alone on its row). The stills touch edge to edge, so the
    focus ring is drawn inside the still (white with a dark keyline), not as an outline the
    next still would paint over.
74. **Next project** = the editor's pick (`next_portfolio_id`) when it is another published
    project, else the next in catalogue order, wrapping (the mockup's rule). The band is one
    link named "Next project: <name>". A .4 black scrim over the poster and a .85 kicker
    (the mockup's .75, no scrim): at its hover opacity over a bright frame the kicker fell to
    ~2.4:1. Gated in `scripts/contrast-audit.mjs` (`nxWorst`).
75. **Structured data**: an extended CreativeWork — `image` (the banner frame, 1200 px JPEG,
    absolute), `dateModified` (the row's `updated_at`), `dateCreated` (the year),
    `keywords`, `genre` (the type), `about` (the sector), `inLanguage` — and a breadcrumb
    Home › Our Work › name. **No Review/AggregateRating**: a client quote on our own page is
    not an independent review. og:image falls back to the same frame when SEO set none.
76. **Metadata**: the title is the mockup's own `document.title` — "<name> | <type>" under
    the brand template; the description is the teaser, else the summary (strictly in the
    page's language), else the mockup's generic line (`CASE_STUDY_META`; the Arabic is ours
    — owner review). The CreativeWork `description` is the same text with `%brand%`
    filled in (`caseSchemaDescription`) — the JSON-LD builder substitutes nothing.
77. **Cache**: Tier A, tagged `portfolio:<slug>`, `portfolio:all` (the next project's card),
    `sectors:all`, `clients:all`, `services:all`, `testimonials:all`.
78. **The banner's CSS is its own route sheet** (`banner.css`), linked by Our Work, All
    projects and the case study, so the case study does not load the catalogue's CSS and
    Our Work does not load the case study's.
79. **Dropped with Lenis, as on Our Work**: the banner parallax, the caption's rest fade,
    the hero loop ignoring reduced motion. Digits stay Latin in Arabic for scope numbers,
    result values, the film length and counts (decision 5); result values are LTR-isolated
    so "+XX%" keeps its sign in front, and realigned to the right in Arabic
    (`text-align: end`) so they sit over their labels. (The contact page's channel values
    are the opposite case — decision 88.)
80. **Every part is its own error boundary** (`SectionBoundary`): a failing part leaves an
    empty placeholder, never a 500.
81. **The lead band paints over a pinned banner** (`.mbanner ~ .lead-band { z-index: 4 }`,
    banner.css — the mockup's `.lead` z-index). The banner stays stuck at the top of its
    page, and the lead band — shared chrome with no z-index of its own — slid UNDER it as it
    scrolled up. This also fixes Our Work, where PR10 shipped the same stacking.

## Acceptance fixes (2026-09-27)

An acceptance check of the live site (main @ fd1bc09) against the mockup, EN + AR at
1366×900 and 412×915.

82. **The persistent current-page underline and the full-opacity header are kept** — the
    one finding not fixed. The mockup draws the Cobalt underline on hover only (HOME carries
    `aria-current` with no mark) and rests the nav at `.85` opacity. The permanent underline
    on `a[aria-current="page"]` is a wayfinding cue a sighted keyboard or low-vision visitor
    can see without hovering, and `.85` would lower the contrast of 12.5px link text over a
    moving video for a purely tonal effect. Both are chrome-wide.
83. **The split hero headline has real spaces.** Words are separated by a space text node,
    as the mockup's `splitLetters()` keeps one, not by `margin-inline-end: .26em`: the
    served h1 read "Creativeworkthatperforms*" to crawlers, reader mode and copy-paste
    (Pillar 3), and the margin set words ~1.6× the design's gap (a space under the h1's
    `-0.035em` tracking), which moved the breaks ("LET'S MAKE / IT HAPPEN"). The trailing
    `*` is its own `.word--mark` (not accented, no space before it — the design's
    `<em>performs</em>*`), so it may drop to the next line alone; it takes the next word
    rung of the stagger ladder with letter offset 0. `aria-label` still names the h1.
84. **Template whitespace next to an element is spelled out** (`{' '}`): Astro's HTML
    compression drops the whitespace between an expression and an element, which glued
    "SOMETHINGTHAT LANDS" (home contact CTA) and "See ourCookie Policy" (consent banner) in
    both languages.
85. **The desktop header is the mockup's space-between** — logo | link row | language pill.
    The brand's `margin-inline-end: auto` (pre-UI-v2) had packed the links against the pill;
    it now applies only at ≤900px, where the key link, menu toggle and pill stay grouped at
    the end.
86. **Ported blocks name the mockup's leading** instead of inheriting the body's 1.6 (the
    mockup's body sets none, so its blocks resolve to `normal`); body line-height is
    unchanged. `normal`: kickers (`.tag`), the clients and social headings in English (Arabic
    keeps the mockup's 1.5), marquee items, social cards, form labels and fields, the filter
    bar (`.fb`), the case study's back link, keyword chips, scope rows and title-band facets,
    and the banner caption's tag and meta line. The home CTA pill is the mockup's `.skip`:
    13px (14px Arabic) and 12px with `12px 18px` padding at ≤720px (the Arabic 14px outranks
    the phone size, as in the mockup). The message box has no `rows`, so the 132px floor is
    its height.
87. **The form note is capped, not boxed** (`max-width: 38ch`, the mockup's), so a one-line
    Arabic note sits flush with the form edge instead of 55px in.
88. **In Arabic the channel values stay LTR-left** under the right-aligned labels (the
    mockup's `.tbox__val[dir=ltr]`), and the social card's ↗ is **not mirrored**: it is the
    external-link glyph, not a reading-direction arrow, and the mockup keeps it (and its
    up-and-out hover nudge) in both languages.
89. **`--bs-header-h` is the bar's real height** — `36px + logo width × 1503/2943` (103px at
    1366, 85px at 412), no longer a flat 72px. About's "who" block (which subtracts it from
    the mockup's `clamp(150px, 22vh, 220px)`) now starts where the design's does; the case
    study's no-banner title band, the token's other user, clears the real header too.
90. **Case-study facets keep their inline flow on phones** (the mockup's `.pt__meta` has no
    phone rule); the cards' two-column phone rule no longer reaches `.facets--case`.
91. **The breakdown sketch stills are borderless**: the mockup's CSS gives them a 1px frame
    but its markup's inline `border:0` overrides it, so the rendered design has none — the
    port follows what renders.

## Services round 2: shared components and Home (S2)

Round 2 regroups the services into five disciplines (28 services). This slice ports the
parts the home page and both services pages share. Mockups: `index.html` (home v2.1) and
`services.html` / `service.html` from the Round 2 delivery.

| Mockup | Site | Where |
| --- | --- | --- |
| `.cats` / `.cats--home` / `.cats__head` / `.cats__stage` / `.cats__foot` / `.cats__hint` | `.disc` / `.disc--home` (`.disc--page`) / `.disc__head` / `.disc__stage` / `.disc__foot` / `.disc__hint` — `ServicesOverview.astro` (type `servicesOverview`, kept) | global.css "Discipline cards" |
| `.cc` / `.cc__top` / `.cc__n` / `.cc__go` / `.cc__bot` / `.cc__cnt` / `.cc__t` / `.cc__s` / `.cc.on` | `.disc-card` (the link) + `.disc-card__clip` (its visual layer) / — / `.disc-card__n` / `.disc-card__go` / `.disc-card__bot` + `.disc-card__s` + `.disc-card__head` / `.disc-card__cnt` / `.disc-card__t` / `.disc-card__line` / `.disc-card.on` + `.disc-card__ring` | global.css |
| `render()` / `grow()` (JS) | server-rendered cards (`src/lib/services/cards.ts`) / CSS view timeline `--disc-rise` | global.css |
| `clip()` / `play()` on `pointerenter` | `MediaFrame mode="hover"` + `src/lib/client/clips.ts` | — |
| the grouped `<select>` (`optgroup` + `cat:<slug>`) | `ContactForm` `groups` / `selected`, `serviceOptionGroups()` (`discipline:<slug>`) | `src/lib/forms/serviceSelect.ts`; global.css (optgroup) |
| `.hello` / `.hello__grid` / `.hello__side` / `.hello__h(--svc)` / `.hello__p` / `.hello__rule` / `.hello__pts` | the same names — `Hello.astro` (type `hello`) | services.css (new route sheet) |
| the hello `<form>` | `ContactForm fields="hello"` (`.contact-form--full.contact-form--hello`) | global.css |
| `.hero__alt` / `.crumb` / `.skipov` / `.hero--one` | Hero `data.altLink` → `.hero__alt` / `data.crumb` → `.crumb` / `data.skipLink` → `.hero__skip` / `.hero--one` (set by `crumb`) | services.css |

## Decisions (S2)

The orchestrator renumbers these at integration.

- **S2-1. The widen is transforms and a clip, never `flex-grow`.** A hover-driven layout
  change counts toward field CLS, because hover is not "recent input" (only mousedown,
  pointerdown and keydown are). Over 0.75 s, the mockup's flex-grow moved every
  neighbour's start position on every frame. Here:
  - each card's visuals (`.disc-card__clip`) are one layer at the widest width;
  - `translate` places the card, and `clip-path: inset(… round 18px)` cuts the layer to its
    current width;
  - the shares are the mockup's (the active card 2.1, the others 0.8; 1 beside a selected
    card at rest). They are computed in CSS from the card count (`:has(> :last-child:nth-child(k))`),
    the card's index (`:nth-child`) and the active card, with container units on the stage;
  - the active card is the hovered one, else the keyboard-focused one, else `.on`.
    Keyboard focus widens a card too; the mockup only widened on hover, so a keyboard
    visitor never saw the short line;
  - RTL is mirrored: a flipped translate sign and the clip's other side;
  - at most 6 cards widen; with 7 or more the stage is a plain row.

  The link's own box stays the card at rest and takes no pointer events; the clipped
  layer does, and clip-path bounds hit-testing too. The arrow, the ring and the poster
  follow the visible edge with `translate` (the ring's width transitions, a layout change
  on one absolutely positioned box whose start edge never moves). The poster box is the
  widest width, re-centred on the visible window, so it crops as the mockup's
  `object-fit` did. The gate is `tests/e2e/layout-shift.e2e.ts`: a hover sweep over the
  home cards, EN and AR, sums to 0. Lighthouse cannot see hover CLS.
- **S2-2. The name size is fixed per stage, and the short line reveals by translation.**
  The mockup sized the name at `10.4cqi` of the card, so the name grew and reflowed with
  the card: a layout shift. The name is now `10.4%` of a card AT REST (Arabic: the
  mockup's `clamp(19px, 1.7vw, 28px)`), and the words never reflow. A squeezed card scales
  its words down (a transform), which is what the mockup's cqi did. The short line's box
  holds the name block just above it; at rest the box is translated down by 100% of its
  own height, which rests the name at the card's foot as drawn. On hover it slides back
  and the line fades in. There is no JS measuring and no max-height.
- **S2-3. The rise is a scroll-driven animation.** It is a view timeline on the stage,
  `transform` + `opacity`, inside `@supports (animation-timeline: view())` and
  `prefers-reduced-motion: no-preference` (the slogan band's precedent). The mockup's
  `grow()` progress maps onto scroll ranges:
  - wide screens: card i starts 4.35vh·i in, eases over 62.1vh, and is opaque after
    9.75vh;
  - phones: each card over the 60vh after its own top enters.

  The hidden from-state lives only in the keyframes, and `.disc-card` is in the
  reduced-motion invariant. Firefox, which has no scroll timelines, shows static cards.
  The section is `overflow: clip`, not `hidden`: a hidden overflow is a scroll container,
  and the view timeline would then track the section instead of the page.
- **S2-4. No clip on touch.** This keeps the existing rule: `clips.ts` never plays on a
  touch-only device, under reduced motion or with Save-Data, and never on a finger landing
  on a hybrid's screen. The mockup autoplayed every card at 60% visibility on touch. This
  is a recorded deviation, and it is part of the EXC-009 surface list (and was on
  EXC-007's until R3-7 closed it).
- **S2-5. A playing clip never transitions its own transform.** In the tests, a hover clip
  whose `scale(1.05)` was mid-transition while playing reported tiny layout shifts
  (≈0.0002 each, Chromium). The poster keeps the mockup's slow zoom; the video, only ever
  visible at the zoom's end state, sits there.
- **S2-6. The card scrim and pill are sized for AA over any poster.** The mockup's bands
  were shares of the card's height (0→26% for the pill, 44%→100% for the words). They left
  the name and count on raw footage on phones (a 250px card puts its words in its top
  half) and under 4.5:1 over a light poster. The scrim is now measured in pixels from the
  card's edges:
  - at least .6 black behind every line of words (measured: ≤ 183px above the foot on wide
    screens when hovered, ≤ 150px on phones);
  - the count at .86 white (the mockup has .74) and the line at .90 (the mockup has .84);
  - the number pill's glass is dark (.4 black instead of the mockup's .14 white).

  `scripts/contrast-audit.mjs` holds the worst case: a white poster. Visually, the lower
  third of a light card is darker than the mockup.
- **S2-7. Counts: Arabic plurals, Western digits.** "8 services" / "8 خدمات", with the
  noun following the plural categories through `Intl.PluralRules` (1 خدمة, 2 خدمتان, 3–10
  خدمات, 11–99 خدمةً, 100+ خدمة). The digits stay Western, per decision 5 (counts keep
  Western digits in Arabic) and as the mockup's Arabic cards draw them. The code fallback
  (a database outage only) is the five names and lines as text, with no counts and no
  media.
- **S2-8. The grouped select.** "Not sure yet", then per discipline an `<optgroup
  label="01 Branding">` opening with "{Discipline}, help me choose" and its services.
  - The Arabic label uses the ARABIC comma, "الهوية البصرية، ساعدوني أختار"; the mockup
    joined every language with a Latin ", ".
  - The value is `discipline:<slug>` (the mockup had `cat:`), posted as
    `disciplineOfInterest`; a service slug posts `serviceOfInterest`.
  - A 422 on either key marks the select.
  - `selected` preselects server-side (the service page). A stale value renders "not sure"
    rather than a broken choice.
  - `[data-preselect]` links set the select on click only while it is empty or on a
    discipline, so a service the visitor chose is never overridden.
- **S2-9. "Say hello" wraps the real form.** `ContactForm fields="hello"` (name, email,
  company, phone, service, budget, message, plus consent and the honeypot) posts as
  `kind=project_inquiry`. The phone is `type=tel dir=ltr`, and the server envelope-encrypts
  it. Budget keeps the stable band keys; the mockup posted the visible labels. The
  deadline field is dropped, as in the mockup.
- **S2-10. The hero's services links are route data.** `altLink`, `crumb` and `skipLink`
  render only when given. Their `<b>` run is split into text and a `<b>` element, never
  injected as HTML (`splitBold`).
  - The crumb is the h1's sibling with its own flex row, not a wrapper around the LCP
    element. `crumb` also sets `.hero--one` (the service page's smaller h1).
  - The skip pill's glass is .5 black and its kicker .88 white (the mockup has .26 / .72),
    so both pass over a white frame. It sits at least one header height down, and hides
    with the covered hero (2.4.11).
  - Its fade-in and the alt link's are registered in services.css's reduced-motion block.
- **S2-11. The "fourteen" copy is rewritten.** Where the mockup had words, they are used
  verbatim:
  - About card c2t: "One studio, five disciplines" / "استوديو واحد، خمسة تخصصات";
  - the home meta: "…Five disciplines, one studio."

  The rest is authored, for owner review:
  - AboutWho's paragraph title (mockup wording plus a period);
  - AboutStory: "five disciplines, one team" / "خمسة تخصصات، وفريق واحد";
  - LeadershipSlider: "keep five disciplines pulling in the same direction" / "يخلّون خمسة
    تخصصات تمشي في نفس الاتجاه";
  - the contact FAQ, which is also its FAQPage JSON-LD: "Take one of the twenty-eight" /
    "خذ واحدة من الثمان والعشرين";
  - the Arabic home meta, "…: خمسة تخصصات، استوديو واحد.".

  ServicesIndex's "Fourteen" goes with the component in S3.
- **S2-12. Performance: the /ar home LCP regression (CI 2680 ms against the 2500 ms
  budget; S1 passed).** Measured with Lighthouse 12.6 on the mobile profile of
  `lighthouserc.json` (simulated throttling), S1 and S2 builds served side by side and run
  interleaved, 7 runs a route, and by recomputing Lantern's LCP graph from the saved
  trace. Lantern's LCP is not the logo's arrival: it is the end of the LAST request that
  finished before the observed paint. On /ar those were the five Almarai faces the page
  lays out, and a face cannot start before global.css has arrived, because the
  `@font-face` rules live in it. S2 grew that render-blocking sheet by 4.3 KB gzipped, and
  the font chain, and so the LCP, moved by the same ~150 ms on every page. Local medians:
  /ar 2492 → 2643 ms, / 1884 → 2049 ms, /contact 1728 → 1873 ms. Four changes, none of
  them to the design, the markup's structure or the CSP:
  - **The served stylesheets are minified.** `scripts/minify-css.mjs` runs in
    `postbuild` and strips comments and insignificant whitespace from
    `dist/client/styles/*.css`, the served copy only; the source keeps its comments.
    global.css drops from 34.9 KB to 14.1 KB gzipped. It is semantics-preserving by
    construction, it never rewrites a rule, and it refuses what it does not model
    (`tests/lib/minifyCss.spec.ts` proves each sheet keeps its token stream). No
    dependency was added.
  - **The video helpers are one chunk.** With the CSS out of the way, the graph's tail
    became a module waterfall: Hero → lazyVideo → clips, three round trips. `manualChunks`
    now puts both helpers in `media-client`.
  - **The logos are sized by their box.** The header logo and the intro logo (the LCP
    element) were 1x/2x density pairs keyed to the desktop box. A phone at DPR 1.75
    fetched the 528w and 1040w files (9 + 17 KB) for 96 px and 189 px boxes. They now
    use width descriptors with `sizes` from their CSS, `clamp(96px, 10vw, 132px)` and
    `min(46vw, 520px)`, so that phone takes 176w + 520w (3 + 9 KB). Every candidate has
    the exact aspect ratio, so the box never reshapes when the file arrives. Desktop
    picks are unchanged: 1x 520w, 2x 1040w for the intro; 176w/264w for the header.
  - **No layout read before the first frame.** SiteHeader's first `offsetHeight` /
    `scrollY` read and the count-up's `getBoundingClientRect` ran at module evaluation.
    When a module evaluated before the first frame (on a loaded machine), the page's
    whole first layout moved into that script's task (158 ms). Once FCP came earlier,
    Lighthouse counted that task as blocking time on the home page (TBT up to 790 ms in
    loaded runs). Both reads now wait for `requestAnimationFrame`.

  After the fix, local medians of 7 (S1 in brackets): /ar 2135 ms (2479), / 1736 ms
  (1882), /contact 1717 ms (1724). TBT is 0 on all three and CLS is unchanged.

## Services page (S3)

`/services` and `/ar/services`, from the Round 2 `services.html` (and `services.html#events`,
the explorer open). The page is section-composed (`pages` slug `services`,
`supabase/seed-data/54-services-page.json`), with `DEFAULT_SERVICES_SECTIONS` until it is:
banner hero → proof → the discipline cards (page mode) → the explorer → "Say hello". One
loader (`src/lib/services/servicesPage.ts`) serves both twins.

| Mockup | Site | Where |
| --- | --- | --- |
| `.hero.hero--contact` + `HERO_SEG` 13.4–15.9 + `.hero__alt` | Hero `withHeroPreset(…, 'services')` → `.hero--banner`, `data.clip`, `data.altLink` | global.css (banner), services.css (alt link; the 55% crop) |
| `.proof` / `.proof__grid` / `.proof__line` / `.proof__rate` / `.stars` / `.stats` / `.stat` / `.stat__n` / `.stat__l` | `statistics` variant `services` → `ServicesProof.astro`: `.svc-proof` / `__grid` / `__line` / `__rate` / `__stars` / `__stats` / `__stat` / `__n` / `__l` | services.css |
| `.cats` (services) | `servicesOverview`, `data.mode: 'page'` (S2) → `.disc.disc--page#categories` | global.css |
| `.xp` / `.xp.open` / `.xp__pad` / `.xp__body` | `serviceExplorer` → `ServiceExplorer.astro`: `.svc-xp` (+ `.is-live` / `.is-open`) / `.svc-xp__pad` / `.svc-panel` (+ `.is-active` / `.is-entering`) | services.css |
| `.xp__tabs` / `.xtab` / `.xtab.on` | `.svc-xp__tabs` / `.svc-tab` / `.svc-tab[aria-selected='true']` — `src/lib/client/tabs.ts` | services.css |
| `.xp__grid` / `.xp__media` / `.xp__cap` | `.svc-xp__grid` (`--solo`) / `.svc-xp__media` + `MediaFrame.svc-xp__mf` (+ `.svc-xp__swap`, `.is-swapped`) / `.svc-xp__cap` | services.css |
| `.xp__k` / `.xp__h` / `.xp__p` | `.svc-xp__k` / `.svc-xp__h` / `.svc-xp__p` | services.css |
| `.xl` / `.xi` / `.xi__a` / `.xi__n` / `.xi__t` / `.xi__q` | `.svc-list` / `.svc-row` / `.svc-row__a` / `.svc-row__n` / `.svc-row__t` / `.svc-row__q` | services.css |
| `.xp__foot` / `.xp__nav` / `.xbtn` / `.cta--go[data-pre]` | `.svc-xp__foot` / `.svc-xp__nav` / `.svc-xp__btn(--prev/--next)` / `<Cta class="svc-xp__start" data-preselect="discipline:<slug>">` | services.css; global.css (`.cta`) |
| `openCat()` / `renderBody()` / `pageBoot()` (innerHTML) | server-rendered panels + `src/lib/client/serviceExplorer.ts` | — |
| `.hello` | `hello` (S2) | services.css |

## Decisions (S3)

The orchestrator renumbers these at integration.

- **S3-1. First paint is CSS; after that the script owns the state.** `/services#events`
  (the home cards, the service pages' crumb, the retired-slug 301s) must open Events with
  no layout shift. A script opening it after first paint would move everything below it
  with no input to excuse the move, and that shift counts. So `:target` shows the addressed
  panel (`.svc-xp:not(.is-live) .svc-panel:not(:target) { display: none }`), and with
  nothing addressed the whole explorer is collapsed.
  - The script then adds `.is-live`, which switches the CSS to its own `.is-open` /
    `.is-active` classes, set to the panel `:target` already showed: the hand-over changes
    nothing on screen, and plays no entrance.
  - From then on a card, a tab, prev/next or a `hashchange` opens a panel **instantly**,
    inside the input's 500 ms window (`hadRecentInput`). Only the panel's inner grid fades
    and rises (`svc-xp-in`, opacity + transform, 0.7 s). The mockup's 0.9 s
    `grid-template-rows` expansion would keep pushing the page after the window closed.
  - The hash follows with `replaceState`, which does not update `:target` — the reason the
    CSS switches to classes rather than trusting `:target` for good.
  - Without JS every card, tab and prev/next is a plain `#slug` link, and `:target` does the
    opening. The gate is `tests/e2e/layout-shift.e2e.ts`: a click-open and a keyboard
    switch count 0, and a `#events` load shifts nothing at all.
  - Before the script (and without it) the addressed panel's pill wears the selected look
    too: `.svc-xp:not(.is-live):has(.svc-panel:nth-child(k+1):target) .svc-tab:nth-child(k)`,
    written out to eight disciplines. It is colour only, so the hand-over to
    `[aria-selected]` shifts nothing.
  - Every `:has()` selector is a rule of its own (or in a list of only `:has()` selectors).
    `:has()` is not forgiving: in a mixed list an engine without it (Firefox < 121, Safari
    < 15.4) drops the whole rule, and the explorer's script-driven hiding went with it, so
    every panel showed stacked. `tests/lib/cssSelectorLists.spec.ts` holds every served
    sheet to that rule (two older lists in global.css, the intro cut, are named there and
    left to their owner).
  - **Standalone.** With no visible card band (an editor hid or removed it), nothing else
    on the page can open the explorer: its tabs are inside it, and a collapsed explorer
    shows nothing. So the route marks it `data.standalone` (`withServicesData`), it renders
    `.svc-xp--standalone`, and CSS shows its FIRST panel when nothing is addressed (an
    addressed one still wins). The script starts from that panel and writes no hash for
    it.
- **S3-2. The tabs are APG tabs, applied by the script.** `src/lib/client/tabs.ts`:
  `role=tablist` (named "Disciplines" / "التخصصات"), `role=tab` with `aria-controls` and
  `aria-selected`, a roving tabindex, and `role=tabpanel` with `aria-labelledby` →
  its tab and `tabindex=0` (a panel whose first content is not focusable joins the Tab
  sequence). Automatic activation: ←/→ move and select, mirrored in RTL (→ is "previous"
  there), wrapping at both ends; Home/End; Enter/Space. There is no region-wide
  `aria-live` (the mockup had one on the whole explorer): the selected tab's own
  announcement is the feedback. The roles are applied only when the script runs, so a
  no-JS page never promises a widget that is not there. Focus: a card click or prev/next
  moves focus to the opened panel and scrolls it into view (its `scroll-margin-top` keeps
  the header's room and the tab row above it); a tab keeps focus on itself. The selected
  card gets S2's `.on` (no ARIA state on the cards: they are links, and the tab carries
  the selection). The tab row scrolls on phones, and a scroller clips at its padding
  edge, so it keeps 6px of room on every side for the global focus ring (2px wide at a
  3px offset, 5px past the pill), taken back with an equal negative margin.
- **S3-3. Every panel is server-rendered.** All five disciplines and their 28 service
  links are in the HTML (Tier A, crawlable), each panel's id the discipline's slug; the
  mockup rendered one panel at a time with `innerHTML`. A panel's poster is a lazy
  `<Picture>` and its clip an in-view `MediaFrame` (clips.ts), so a hidden panel costs no
  image and no video bytes until it is shown, and never on touch, under reduced motion or
  with Save-Data. Outage fallback: the cards' five names as text-only panels (no services,
  no count, no media), so a fallback card's `#slug` link still opens something.
- **S3-4. The row hover swap is data attributes, never markup.** Each row carries a
  server-computed WebP URL (`getImage`, one per distinct still, 1200w — hover means a mouse
  or pen) and its clip window in `data-xp-*`. On hover or focus the script paints an
  overlay `<img>` (created once, then only its `src` changes) once decoded, rewrites the
  caption with `textContent`, and moves the frame's clip with `clips.ts retargetClip()`;
  leaving the list restores the discipline's. `clips.ts` now reads a frame's window on every
  tick (it captured it once), which is what makes a live retarget possible. A service with
  no poster or clip of its own keeps the discipline's, so the media never goes blank. The
  rows use `data-xp-clip-*`, not `data-clip-*`: the latter would make clips.ts wire every
  row as a frame.
- **S3-5. The proof band is the `statistics` `services` variant, namespaced `.svc-proof`.**
  The mockup's `.proof` / `.stats` names are Our Work's. The numbers are the counters placed
  on `services` (their Services-page labels), rendered final on the server and counted up
  by `countUp.ts` only while still off screen. The statement is built-in copy (overridable
  `line` + `lineAccent`).
- **S3-6. The rating line is content only, and never structured data.** "★★★★★ 4.9 / 5
  average client rating" is a claim with no table behind it. It renders only where it is
  authored (`rating: {value, label}`), and the one place it is authored is the seeded row,
  which is flagged `is_placeholder` for exactly this reason (production shows it only under
  the owner's override, runbook §6d). It is never a component default, and never in
  `DEFAULT_SERVICES_SECTIONS` either: that default renders whenever the composition comes
  back empty (the page unpublished, every section hidden, a failed read), code is never
  behind the 0025 fence, and so a sample there would reach production, and the Tier A edge
  cache, unflagged. The seed-equality test allows the seed row that one extra key. There is **no
  AggregateRating JSON-LD**: it would assert review data the site does not have (a
  manual-action category). The value is isolated LTR (`<b dir="ltr">`), as in the mockup's
  Arabic. The whole band hides with fewer than two published counters, so the rating line
  is never the only sample left standing.
- **S3-7. The page's links follow the bands that are there.** The hero CTA goes to
  `#categories`, the alt link ("Know what you need? **Skip to the inquiry**") and every
  "Start your {Discipline} project" to `#inquiry` — or, with "Say hello" hidden, to
  `/contact#inquiry`. With the cards hidden the CTA goes to the standalone explorer's
  first panel (`#<slug>`, S3-1), else to the form (`servicesPageLinks`, the home CTA's
  rule). And a floor: while the page-mode cards show, the explorer shows too
  (`ensureServiceExplorer`), because the cards are `#slug` links into it and it carries the
  page's service links. If the hero is hidden the page wears the solid
  header and a visually hidden h1.
- **S3-8. Explorer copy.** "Inquire" / "اطلب", and "Start your {Discipline} project" /
  "ابدأ مشروع {Discipline}" are the mockup's `x.*`. The section's content is only those two
  labels (strict); `startLabel` must carry `{discipline}` in both languages. The key line
  reads "01 / 05  8 services", with the cards' plural rule and Western digits (S2-7). The
  Inquire pill is named "Inquire: Logo Design" (its visible text starts the name, 2.5.3);
  the prev/next links carry a screen-reader prefix ("Previous discipline: …"), since their
  visible text is only a name; the row number is `aria-hidden` (the `<ol>` numbers the
  rows). With a mouse the pill shows on its row's hover or focus, as in the mockup; on touch
  it is always visible.
- **S3-9. The caption pill is darker than the mockup's.** Its glass is .7 black (the
  mockup's .35), so over a white poster the name is 8.4:1 and the number, in sky-soft, 5.4:1
  (the mockup's sky there is 1.9:1). `scripts/contrast-audit.mjs` holds the worst case.
- **S3-10. The Arabic head copy is ours.** `PAGE_META.services`: the English title and
  description are `services.html`'s, verbatim; the Arabic title is the menu label
  ("الخدمات") and the description the English one in the page's own Arabic words. It is
  flagged for owner review.
- **S3-11. The LCP element is the banner loop's first frame.** Lighthouse records the hero
  `<video>`, not the h1: the loop mounts after `load`, and its first frame out-sizes the
  headline, which was the candidate until then. `/contact` behaves the same way, although
  its §6 row names the h1. The first S3 measurement ran on the S2 tip before S2-12. There,
  `/ar/services` was over budget (simulated LCP 2.68–2.85 s, perf 0.93–0.95). Rebased onto
  S2-12, `services.css` is minified too (6.5 → 3.4 KB gzipped) and the budget holds.
  Lighthouse 12.6 ran the `lighthouserc.json` profiles, 5 interleaved mobile runs and 3
  desktop runs, with the page's data mocked from the seed (28 rows, card and panel posters,
  the four `services` counters):
  - mobile, `/services`: LCP 1.95 s, perf 0.99;
  - mobile, `/ar/services`: LCP 2.22 s (2.21–2.30), perf 0.98;
  - mobile, `/ar/contact` (control): LCP 1.92 s;
  - desktop: 0.55 s and 0.68 s, perf 0.99 or more.

  With the code fallbacks and no data, the mobile LCP is 1.71 s and 2.08 s. The ≈0.15–0.25 s
  difference is the posters and counters. Since the frame paints after `load`, everything
  that finishes before `load` sits in its Lantern graph (S2-12). A band that adds eager
  bytes above the fold on this page therefore spends LCP budget directly. The margin on
  `/ar/services` is ≈0.28 s. The structural fix is not in the page. It is a Hero-wide
  treatment that keeps the loop's first frame from becoming a candidate, or Stream
  (KAN-20). Both are owner items, and so is correcting the contact row.


## Service page (S4)

`/services/[slug]` and `/ar/services/[slug]`, one per published service (28 seeded), from
the Round 2 `service.html`. One loader serves both twins (`loadServicePage`,
`src/lib/services/page.ts`); the route asks `resolveServiceRoute` for one of three answers:
the page, a 301 for a retired slug, or a real 404.

| Mockup | Site | Where |
| --- | --- | --- |
| `service.html?s=<slug>` | `/services/[slug]` + `/ar/services/[slug]` — `ServicePage.astro` + `loadServicePage` / `resolveServiceRoute` | `src/components/service/`, `src/lib/services/page.ts` |
| `.hero--contact.hero--one` + `.crumb` + `.skipov` | `Hero` direct render: `data.banner`, `data.clip`, `data.crumb`, `data.skipLink` (S2's props) → `.hero--banner.hero--one`, `.crumb`, `.hero__skip` | services.css (S2 block) |
| `.what` / `.what__grid` / `.what__lead` / `.what__body` / `.get` / `.get__k` / `.get__list` | `.svc-what` / `.svc-what__grid` / `.svc-what__lead` (h2) / `.svc-what__body` / `.svc-get` / `.svc-get__k` (h3) / `.svc-get__list` — `ServiceWhat.astro` | services.css (S4 block) |
| `.val` / `.val__head` / `.val__grid` / `.vcard` / `.vcard__top` / `.vcard__n` / `.vcard__plus` | `.svc-val` / `.svc-val__head` / `.svc-val__grid` (a list) / `.svc-vcard` (inside its `li`) / `.svc-vcard__top` / `.svc-vcard__n` / `.svc-vcard__plus` — `ServiceValue.astro` | services.css |
| `.case` / `.case__t` / `.case__meta` / `.case__top` / `.case__img` / `.case__see` / `.case__k` / `.case__ctx` | `.svc-case` (`#case`) / `.svc-case__t` (h2) / `.svc-case__meta` (a list) / `.svc-case__top` / `.svc-case__img` / `.svc-case__see` / `.svc-case__k` (h3) / `.svc-case__ctx` — `ServiceCaseBlock.astro` | services.css |
| `.probs` / `.probs__head` / `.prob` / `.prob__n` / `.prob__p` / `.prob__s` | `.svc-probs` / `.svc-probs__head` / `.svc-prob` (in `ol.svc-probs__list`) / `.svc-prob__n` / `.svc-prob__p` / `.svc-prob__s` | services.css |
| `.res` / `.res__i` / `.res__n` / `.res__l` | `.svc-res` (a list) / `.svc-res__i` / `.svc-res__n` / `.svc-res__l` | services.css |
| the hello section with `v.helloH` / `v.helloP` | S2's `Hello` with `headingOverride` (`serviceHelloHeading`), `leadOverride`, `selected`, `groups` | services.css (S2 block) |
| `.more` / `.more__head` / `.more__all` / `.xl.more__list` / `.xi` / `.xi__a` / `.xi__n` / `.xi__t` / `.xi.is-here` | `.svc-more` / `.svc-more__head` / `.svc-more__all` / `.svc-more__list` / `.svc-more__row` / its `a` / `.svc-more__n` / `.svc-more__t` / `.svc-more__row.is-here` + `aria-current="page"` — `ServiceMore.astro` | services.css |
| `.fab` / `.fab__ico` / `pageScroll()` | `.svc-fab` / `.svc-fab__ico` + `.svc-fab__mark` — `ServiceFab.astro` + `src/lib/client/serviceFab.ts` | services.css |
| `pageLang()` (all of the above filled by script) | server-rendered (Tier A) from `services`, `disciplines`, `service_cases` (0028) | — |

## Decisions (S4)

The orchestrator renumbers these at integration.

- **S4-1. Real URLs, and a real 404.** The mockup read `?s=<slug>` and fell back to Logo
  Design for anything it did not know, so every mistyped link rendered a page. Here each
  service lives at its own path, and a slug that is not a published service is a real 404
  (status 404, in the page's language: the Arabic 404 under `/ar`). RLS decides what is
  published, including the 0028 rule that hides every service of an unpublished
  discipline, so archiving a discipline takes its pages down with no code change.
- **S4-2. The floating button stays hidden after the form.** The mockup hid it only while
  the form was on screen and brought it back below it, pointing at a form the reader had
  just passed. Here it shows once 60% of the hero is behind the reader, and hides for good
  once the form's top rises above 85% of the viewport.
  - It is driven by two IntersectionObservers, not a scroll handler. The hero is sticky
    and never leaves the viewport, so a 1px mark in the page's flow stands in for "60% of
    the hero". Its `top` is set through the CSSOM (CSP-safe) and follows the hero's
    height through a ResizeObserver.
  - While hidden it is `inert`, `aria-hidden` and `tabindex="-1"`, and a transform parks
    it below the viewport. There is no `display` toggle, so showing it moves nothing.
  - While it shows, `scroll-padding-bottom` keeps keyboard focus from being scrolled
    under it (WCAG 2.4.11).
  - It rides above the PDPL consent banner while that is open. The banner is fixed to the
    same bottom edge on a higher layer (z-80) and is open on every first visit, so the
    button was shown and focusable but hidden under it. A ResizeObserver on the banner
    publishes its height as `--svc-fab-lift` on `<html>` (CSSOM; 0 once a choice hides
    it), the shown button is lifted by that much with a transform, so it drops back on the
    same compositor-only transition, and the scroll padding adds it too. The mockup has
    no banner. The e2e keeps the banner open and asserts the button is the element under
    its own centre, then closes it and asserts the button is back at the edge.
  - Without JS it never shows. The hero's skip pill is the same link and is always there.
- **S4-3. The body is sanitised on render.** "What it is" renders the service's Tiptap
  JSON through the allowlist renderer on every render (`toServiceDetail` →
  `renderBody`), never the stored `body_html`, which the database accepts from writes
  that skip the admin API's sanitiser. This closes the gap decision 67 recorded for the
  old ServiceDetail, which is deleted. Links in the body are Klein: the site's sky link
  colour is 2.6:1 on paper.
- **S4-4. The title is brand-first.** `%s` is "{Service} | {Discipline}", so the tab reads
  "Braiin Statiion | Logo Design | Branding". This is the site's title template
  (`src/lib/seo/title.ts`) and the mockup's static `<title>`; the mockup's script
  reordered it to "Logo Design | Branding | Braiin Statiion" after load. A service in no
  discipline is titled with its name alone. The meta description is the tagline, strictly
  in the page's language; the fallback is service.html's own `<meta>` in English and
  ours in Arabic (`SERVICE_PAGE_META`, owner review). og:image is the service's poster
  as a 1200px JPEG, unless the SEO role set one.
- **S4-5. The retired slugs answer a 301.** `src/lib/services/retired.ts` is the plan's
  ten-row table, code-owned because the `redirects` table never reaches the edge today.
  - It is consulted only after the lookup misses, so restoring an archived service in the
    admin brings its page back and the redirect stops applying.
  - It is locale-aware (`/ar/services/music` → `/ar/services/music-vo-sfx`), and the
    fragment stays on the localized path (`/ar/services#branding`).
  - The 301 carries `Cache-Control: public, max-age=86400`. It is not Tier A and is never
    purged, so a restore takes effect within a day.
  - The lookup uses own properties only, so a `/services/constructor` is a 404 and never
    something on `Object.prototype`.
  - A test checks the map against the seeds: every target is a live service or discipline
    panel, no target is itself retired, and no retired slug is a live service.
- **S4-6. The hero is the banner hero with the service's own clip.** It plays the
  service's window of the reel. Without one it plays its discipline's window, and without
  either the default reel, so no page opens on a still. The sub line is the service's
  tagline. A service with no tagline has no sub line (`data.noSub`), not the home hero's
  "From the brain to the real world.", which is what Hero shows when it is given none. The
  crumb reads "Services / {Discipline}" and links to `/services#<discipline>`. The CTA is
  "See the case study" →
  `#case`, or "Skip to the inquiry" → `#inquiry` when there is no case (no dead link). The
  LCP element is the h1 (CLAUDE.md §6), as on Contact.
- **S4-7. The case block.** Its client and sector are the project's, as the chips show.
  - The client and sector chips open All projects filtered by that value, as the mockup
    linked `projects.html?client=`. A client RLS hides is "Confidential client" as text,
    never a link, because a filter URL would disclose its slug.
  - The image is the project's poster, linking to its case study, with the project's name
    as its alt. With no published project, or a published project with no poster, the
    case shows the service's poster: unlinked, with no pill and its own alt. A project
    with no poster keeps its chip (`src/lib/services/caseFigure.ts`).
  - The image's `sizes` follows its layout. Beside "Where they were" it is the grid's wide
    column. Alone on its row (no context) it spans the 1280px wrap, so it is described as
    `min(100vw, 1280px)` and offered a 1600w file. Described as the column, it fetched an
    800w file upscaled about 1.5x on a 1x laptop.
  - The kicker's dot is sky, as the mockup's `.case .tag .dot` and S2's `.hello` have it.
    The site's default Klein dot is about 2:1 on the black band.
  - The "See the full project" glass is .6 black (the mockup's .35), so its label passes AA
    over a white poster.
  - The problem → what-we-did rows are an ordered list, not anonymous divs. Each cell
    carries its column name for assistive tech (sr-only), and the visual column heads are
    `aria-hidden`. On phones the "What we did" label is drawn from `data-k` with an empty
    CSS alternative text (`content: attr(data-k) / ''`), so it is read once, not twice.
  - The result cards fit as many columns as the width allows: three at the mockup's
    widths, one on phones, and never an empty column for a case with two results.
  - The band is absent when the service has no published case.
- **S4-8. The value cards.** The reveal is on each list item and the hover lift on the
  card inside it, so the two transforms never override each other. The mockup's shared
  transition also dropped the reveal's fade. On the hover wash the number is the soft sky:
  the mockup's sky is 3.1:1 where an RTL card's number sits. The cards are not links, so
  the hover is decoration. It is off under reduced motion, with the case image zoom and
  the "More" row nudge.
- **S4-9. "More in {Discipline}" has its own row classes.** The list uses
  `.svc-more__*`, not the `/services` explorer's `.svc-list` / `.svc-row`. The two were
  built in parallel, and one page's rows must not restyle the other's (a merge candidate
  for S5). The current row is Klein and carries `aria-current="page"`; it stays a link, as
  in the mockup. There are two columns from 900px. The section is absent for a service in
  no discipline.
- **S4-10. Structured data.** The Service node carries `serviceType` (its name),
  `category` (its discipline), the poster as `image`, `areaServed: SA` and the studio as
  `provider`. It has no `inLanguage`: schema.org defines that on CreativeWork, Event and a
  few other types, not on Service, and the validator reports it unrecognised. The page's
  language is `<html lang>` and hreflang. A test holds the node to Service's and Thing's
  properties. The BreadcrumbList is Home › Services › Service. The visible
  crumb's discipline step is left out because its URL would be a fragment
  (`/services#branding`), which search engines fold into `/services`. There is no
  Review or AggregateRating markup: the case block is our own sample content.
- **S4-11. In-page targets clear the header only where they need to.** `#case` and
  `#inquiry` take a `scroll-margin-top` equal to the header's height minus the band's own
  top padding. That is zero on most screens, and only a short viewport gets the
  difference. The band's colour still meets the viewport top, as in the mockup
  (scroll-margin 0), and `/services/<slug>#inquiry` lands on the form.
- **S4-12. Discovery.** The sitemap lists every published service, EN + AR, with the
  row's `lastmod`. It was already built that way; retired slugs are archived, so they
  never appear. llms.txt lists the services under a `### {Discipline}` heading each, in
  catalogue order, with no counts. A service in no discipline goes last under "Other
  services", and a failed disciplines read gives the flat list. A service is never
  dropped because its group could not be named.
- **S4-13. A fragment arrival lands at once.** `/services/<slug>#inquiry`, reached from
  an "Inquire" pill or the `/services` explorer, jumps straight to the form, as the
  mockup's `pageBoot()` did (`immediate: true`). The site's `html { scroll-behavior:
  smooth }` otherwise turned the browser's fragment scroll into a ~2s sweep through
  every band above the form. That is disorienting after a page change, and a lot of
  motion for a reader who has not set reduced motion. `src/lib/client/landOnHash.ts`
  calls `scrollIntoView({ behavior: 'instant' })` once, on load, and the target's
  `scroll-margin-top` still applies. In-page links (the hero CTA, the skip pill, the
  floating button) keep the smooth scroll.
- **S4-14. The crumb sits on the h1 (a fix to S2's hero layout).** S2's crumb is the h1's
  flex sibling on a row of its own. Beside the taller side column, the h1 sank to the
  foot of its row and left the crumb about 60px above it at 1366px, in both languages.
  From 1081px, `.hero--one .hero__inner` is now a two-column grid: the crumb and the h1
  stack in the first column, and the side column spans both rows. The crumb's row is
  `1fr`, so the h1's row hugs the h1. The h1 is still not wrapped, since it is the LCP
  element. Below 1081px the side column already wraps under the h1 and S2's flex layout
  reads right. Measured against the mockup at 1366 and 412, EN and AR, for logo,
  music-vo-sfx and booth-production, every section's top, height and width matches to
  the pixel. The one exception is the inquiry band, which is 25–64px taller because the
  site's form carries the PDPL consent row.

## Round 3: gap fixes (R3)

- **R3-7. One motion switch in the header, not a control per surface (closes EXC-007).**
  The reference design ships no pause control anywhere; the owner chose to build one
  (G3) and put it where EXC-007's close condition recommended: a 32 px round icon button
  after the language pill, styled like it, on every page (`SiteHeader.astro`). It is the
  single WCAG 2.2.2 control for everything that moves on its own — the hero, slogan,
  banner and service hero loops, the in-view and hover clips and the explorer clip, the
  clients marquee, the hero scroll cue, the banner caption's pulse — and it composes with
  the testimonials carousel's own APG control (a global pause sets `userPaused`, so its
  button honestly shows Play; a global resume leaves it stopped — only its own Play
  restarts it). One fixed accessible name ("Pause motion" / "إيقاف الحركة") + `aria-pressed`
  (the removed hero control swapped label and pressed state, an APG anti-pattern); two
  inline SVGs swapped by CSS on the pressed state. The state is `body.motion-paused`,
  owned by `src/lib/client/motion.ts` (no imports, so the header never pulls video code)
  and broadcast as a `motion-updated` event, the `consent-updated` pattern. Remembered
  per tab in `sessionStorage` (`bs_motion`, the removed control's key) — a functional
  setting, so no consent gate. **A paused visitor downloads nothing:** `lazyVideo.ts`
  defers the mount (a pending set, mounted on resume, played only if still on screen)
  and `clips.ts` never creates the `<video>` (hover clips included — simpler and stricter
  than arguing a hover is user-initiated). The CSS loops are held with
  `animation-play-state: paused` (a resume continues where it stopped), never `animation:
  none`, and **never a blanket `body.motion-paused *`**: a stored pause restored on home
  would freeze the intro plate opaque. The button is hidden by CSS under
  `prefers-reduced-motion` (nothing moves there) and `@media (scripting: none)` (nothing
  would answer it), and is never shown or hidden by script after first paint (the
  layout-shift gate). The header's "in use" check now counts only `:focus-visible`: a
  mouse click leaves focus on the button, and any-focus kept the bar from hiding for the
  rest of the scroll. Phone sizing: the switch is a sixth bar item; at 412 px the old
  24 px gap squeezed the logo (`max-width: 100%`) to 76 px, so the phone breakpoints
  tighten gaps, paddings and the switch (28 px, above the 24 px WCAG 2.5.8 floor) and
  the logo holds its 96 px minimum from 360 px up in both languages
  (`tests/e2e/header-footer.e2e.ts`). Asserted in `tests/e2e/motion-pause.e2e.ts` (EN + AR),
  a normal-motion axe pass scoped to the header (the reduced-motion pass never saw the
  button), and `media-bytes.e2e.ts`'s "paused visitor". EXC-009 is re-signed, not
  closed: only Stream (KAN-20) closes it.
