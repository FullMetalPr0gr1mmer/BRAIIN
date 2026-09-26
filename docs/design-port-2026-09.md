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
36. **Person JSON-LD names only the real leaders the page shows** (none when the leadership
    section is hidden), with `jobTitle` and `sameAs` (LinkedIn). A placeholder row
    (`is_placeholder`) never emits a Person node — in any environment, including production
    once the 0027 override and runbook §6c publish the seeded "Name Surname" leaders: their
    cards show (the owner's decision), but structured data is read as fact about real people
    at the studio. The legacy `team` grid's Person nodes follow the same rule.
37. **The About manifesto is the About page's own copy**, verbatim (it differs from the home
    "why us" columns: "between vendors", no "Arabic, English, or…" sentence), and the h1's
    accent includes the final period, as the mockup's `<em>` does.
