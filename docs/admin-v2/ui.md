# Admin v2: UI port and information architecture

> **Status: design input to the Admin v2 program, written 2026-10-03.** Where this
> document and [README.md](README.md) disagree, README wins: its program decisions
> (P-1 to P-15) and the adversarial review in [verification.md](verification.md) were
> applied after this design was written. Design slice ids (AV-01 to AV-34) map to program
> slices in README's slice tables. Inputs it cites by file name (design.txt, grp-*.txt,
> linkage.txt, code-summaries.txt) were working notes of the mapping pass and are not
> in the repository; the client's prototype and ADMIN_TDD.md are the handoff.

## Summary

Admin v2 is ported as a design-system swap plus a page-centric IA, not a paste of the mockup. One coordinated rewrite of public/styles/admin.css (AV-02) brings in the mockup's look: Klein, cobalt and sky; a midnight #0B0D14 sidebar on a #F5F6FA ground; 14px cards; self-hosted Archivo and Almarai, now including Almarai 800. Every failing pair from design.txt is fixed and checked in CI: dim2 becomes #626A7F, sidebar labels use white at .55 (#919295), badge text uses #067647, #B54708 and #B42318 on solid tints, control borders and the toggle-off track use #828B9E (3.42:1), and chart and avatar colours are all at least 4.5:1. All existing JS and test hooks are kept, so every current screen takes the new look on day one. Next comes the component library in three layers. Zero-JS Astro primitives cover the shell, page heads, cards, tables, KPIs and SVG charts, which have table alternatives. React islands are named Admin*.tsx and are used only where there is state. The vanilla enhancers include a framework-agnostic Sortable that supports pointer drag, the keyboard, and up/down buttons for WCAG 2.5.7. Icons come from a same-origin SVG sprite, so they add no JS. The sidebar keeps the mockup's groups: Overview / Content / CRM / Hiring / Growth / Appearance / Settings. nav.ts is still derived from ROLE_CAPS and gains icons, counts and match-prefixes. Every repo module the mockup lacks has a home: Blog under Content, Style-Finder under Growth, Job applications in an Admin-only Hiring group, logs inside Site health, redirects inside SEO, maintenance and page visibility inside General. Retired routes 302 to their new homes. Content screens save through one useEntitySave hook. Until the release backend lands it does an explicit Save with version/409 checks; afterwards it switches to debounced draft autosave behind the site-wide savebar. Maintenance and page visibility stay immediate, confirmed switches, and I agree with the owner's note: both sit in the same §5 Admin+Developer row and are Pillar-1 kill switches enforced in the Worker before the cache. Developer cannot publish, so staging them would take the switch away from the role that holds it. A5 uploads go to a public Supabase Storage bucket for images only. Files are byte-sniffed, capped at 10 MB, need alt text in EN and AR, and are delivered through the existing cloudflare-binding image service (/_image), so CSP needs no change. Two public data features land: the FAQ moves from code into a faq_items table that feeds both FaqAccordion and FAQPage JSON-LD; and a site_chrome singleton offers bounded header, footer and intro options. A versioned same-origin theme.css carries a contrast gate shared by the public site and the admin. The plan has 34 PR-sized slices. Slices AV-01 to AV-23 do not depend on the release backend. AV-24 to AV-31 need its drafts API, releases API and preview route. AV-32 and AV-33 are optional later work, and AV-34 is the closing slice that turns captures into visual baselines. Two cross-program risks need an owner decision early. The 300 KB gz admin budget is a sum, and this program alone projects about 281 KB before any CRM screens. And a set of mockup features is deliberately not built (listed in deviations).

## 0. Scope, inputs and the contracts this design consumes

**Binding inputs**
- The owner decisions A1–A5 of 2026-10-03.
- CLAUDE.md, cited by section below.
- The findings in design.txt, grp-*.txt, linkage.txt and code-summaries.txt.
- The real code as of `479b675`.

**Release backend (REL).** The UI binds to REL through one client module, `src/lib/admin/release.ts`, so a rename upstream is a one-file change. The design assumes REL provides:
1. **Drafts.** `PUT` a draft of entity `<type>:<id>` with `base_version`. It answers 409 on conflict. Drafts are composite for `save_portfolio`.
2. **Pending changes.** A count, plus a list of changes with entity, author, time and changed field names. List projections carry a per-entity `pending` flag.
3. **Publish.** Publishes all changes (or a selected set), with a note and a dry-run validation, and returns `version`.
4. **Discard.**
5. **Release history.** History, preview-at-version and rollback.
6. **Preview route.** A staff-only Tier C route that renders public pages with drafts overlaid. It must:
   - be `X-Robots-Tag: noindex`;
   - carry no RUM, analytics beacon or consent banner;
   - wrap each rendered section in `data-preview-section="<id>"`;
   - load `src/lib/preview/bridge.ts` and `/styles/preview.css`. Both are built by this program; neither ever loads on a Tier A page.
7. **A purge-by-tag helper.**
8. **Media usage that includes drafts.**

**CRM core and the Sales role.** The CRM architect owns these:
- the `sales` value of `app_role` and the CRM caps;
- the Leads, Contacts and Tasks screens;
- lead events.

This design gives them:
- the nav group;
- the kit;
- the dashboard widget registry;
- the notifications feed hook.

**Later phase, hooks only.** These are not built:
- Inbox, Campaigns, Automations, Templates, CRM reports, Export & audiences, Get connected, CRM & messaging;
- Help centre, Arabic admin, 2FA;
- GA4 and pixel injection;
- uptime, Lighthouse and Search Console ingestion;
- the link crawler;
- team notes.

AdminLayout reserves `guide?` and `needs?` props for the help and connection banners. No dead nav entries are added.

## 1. Design system port

### 1.1 Final tokens

Every value below is asserted by `scripts/contrast-audit.mjs`. Contrast was computed with the WCAG formula. Grounds: card #FFFFFF, bg #F5F6FA, surface-2 #FAFBFE, preview #E9ECF3, midnight #0B0D14.

| Token | Value | Use | Proof / fix |
|---|---|---|---|
| `--ad-primary` | `var(--bs-klein, #0024BC)` | primary button, active nav fill, links, switch on, selection ring | white 10.61; on card 10.61 |
| `--ad-primary-hover` | `var(--bs-cobalt, #024CFF)` | primary hover | white 6.03 |
| `--ad-accent` | `var(--bs-sky, #22A9FF)` | decorative only | never a text ground (white on it is 2.56) |
| `--ad-primary-soft` / `-soft-bg` | `color-mix(in srgb, var(--ad-primary) 8%, #fff)` = #EBEDFA / same over #F5F6FA = #E1E5F5 | klein badges, notes, chips, selected rows | primary 9.11 / 8.45; ink 16.66; dim 4.73 |
| `--ad-ink` = `--ad-midnight` | #0B0D14 | text; sidebar, savebar, toasts, code | 17.97 bg / 19.41 card |
| `--ad-bg` · `--ad-card` · `--ad-surface-2` · `--ad-preview` | #F5F6FA · #FFF · #FAFBFE · #E9ECF3 | grounds | |
| `--ad-line` / `--ad-line-2` | rgba(11,13,20,.08) / .14 | card and row hairlines | decorative only (1.24); never a control boundary |
| `--ad-control` | **#828B9E** | input/select/textarea borders, toggle-off track, checkbox and radio edges | fixes 1.4.11 (line2 #DDDDDE 1.36, track #CBD1DE 1.53). 3.42 card, 3.17 bg, 3.31 surface-2 |
| `--ad-dim` | #5B6478 | secondary text | 5.49 / 5.93 / 5.02 preview |
| `--ad-dim2` | **#626A7F** | th, hints, `.tiny`, kbd, chart axes, placeholders | fixes #8A93A6 (2.86–3.09). 5.00 bg, 5.40 card, 5.22 surface-2, 4.57 preview |
| `--ad-side-text` | #BBBBBD (white .72 as a solid colour) | nav links | 10.13 |
| `--ad-side-label` | **#919295** (white .55) | sidebar group labels, env pill | fixes .38 (3.54). 6.24 |
| `--ad-focus` / `--ad-focus-dark` | #024CFF / #22A9FF | focus ring on light grounds / on midnight | 6.03 card, 5.59 bg / 7.57 (cobalt on midnight is only 3.22) |
| `--ad-ok-text` / `-ok-soft` | **#067647** / #E3F6ED | ok badge, KPI up | 5.06 (was 3.92) |
| `--ad-warn-text` / `-warn-soft` | **#B54708** / #FEEFDD | warn badge, missing-AR cue | 4.81 (was 4.14) |
| `--ad-err-text` / `-err-soft` | **#B42318** / #FEECEB | err badge, danger buttons, required `*`, inline errors | 5.76 tint, 6.57 card (was 3.29 / 3.76) |
| `--ad-sky-text` / `-sky-soft` · `--ad-gray-soft` | #0B6EB0 / #E0F3FF · #EFF0F2 | sky badge · gray badge | 4.76 · dim 5.20 |
| note text | warn #8A4B00 · ok #0A6B3E | `.note--warn` / `.note--ok` | 6.03 · 5.86 |
| `--ad-ok` / `-warn` / `-err` | #12B76A / #F79009 / #F04438 | icons and dots **on midnight only** (toasts, savebar dot) | 7.40 / 8.27 / 5.17; forbidden on light grounds |
| `--ad-series-1..7` | primary, #0B6EB0 (dashed), #B54708, #067647, #6941C6, #C11574, #475467 | chart strokes and fills, legend chips | ≥4.5 on card, ≥4.1 on bg. Mockup's sky/amber/green (2.4–2.6) dropped |
| `--ad-tone-0..7` | #0024BC, #024CFF, #0B6EB0, #6941C6, #C11574, #067647, #B54708, #475467 | avatar grounds behind white 12px/800 initials | 5.42–10.61. Mockup's #E4457B 3.86, #12B76A 2.62, #F79009 2.35 and borderline #7A5AF8 4.52 replaced |

**Other tokens**
- Radius: `--ad-r` 14px for cards, `--ad-r-sm` 10px, `--ad-r-xs` 8px, pill 999px.
- Shadows: `--ad-shadow` and `--ad-shadow-sm` take the mockup values. `--ad-primary-shadow` is `color-mix` at 25%.
- Layout: `--ad-side` 256px, `--ad-top` 64px.
- Easing: `--ad-ease` equals `--bs-ease` (cubic-bezier(.16,1,.3,1)).
- Scrim: rgba(11,13,20,.45) with `backdrop-filter: blur(3px)`.

**Which tokens follow the theme.** Only primary, hover and accent follow the published theme, through `--bs-*` from theme.css (see §4 Theme). Everything else is fixed. The theme gate covers the admin pairs, so no accepted theme can break the admin's AA.

### 1.2 How admin.css is rewritten

**One coordinated token-and-primitive rewrite (AV-02), then additive components per slice.**
- admin.css is token-driven, so the palette swap is one block.
- But the shape changes touch every primitive: radius, card anatomy, dotted pill badges, inputs, buttons, table look and toasts.
- Changing them incrementally would show gold-editorial and Klein screens side by side while the client reviews each slice, and would mean maintaining every primitive twice.

**Hooks that stay unchanged.** JS and the tests depend on these: `.card`, `.badge[data-status]`, `button/.btn[data-variant]`, `.msg[data-kind]`, `.field`, `.field-group`/`.field-legend`, `.row-2`, `.bar/.bar-fill[data-width]`, `dialog.admin-dialog`, `.toast[data-kind|data-state]`, `#admin-toasts`, `.tabs a[aria-current]`, `button[role=switch]`, `table.data`, `.toolbar`, `[data-sync]`, `[data-layout]`, `.visually-hidden`.

**New class vocabulary.** The new vocabulary uses the mockup's class names wherever they do not collide, which makes parity reviews easy: `.side`, `.top`, `.ph`, `.kpi`, `.li`, `.drw`, `.mdl`, `.seg`, `.chip`, `.ed`, `.sec`, `.fgroup`, `.repeat`, `.imgf`, `.vidf`, `.tagsf`, `.tog`, `.colorf`, `.range`, `.media/.mi`, `.dropzone`, `.note`, `.empty`, `.tl`, `.stat-row`, `.legend`, `.hs`, `.cmd`, `.savebar`.

| Collision | Repo meaning (kept) | Mockup meaning | v2 resolution |
|---|---|---|---|
| `.card` | padded box | unpadded, with `__h/__b/__f` | Keeps 20px padding unless it has a `.card__h`/`.card__b` child. That rule is a separate all-`:has()` rule, per tests/lib/cssSelectorLists.spec.ts |
| `.grid` | auto-fit minmax(14rem) | fixed g2/g3/g4/g-2-1/g-1-2/g-3-2 | `.grid` stays auto-fit. Add `.grid--2/--3/--4/--2-1/--1-2/--3-2`, which collapse by `@container` on `.content`, not by viewport (admin.css L209–215 "content decides") |
| `.badge` | outlined square, `data-status` | pill with dot and tone modifiers | Pill with a dot. Tone comes from `data-tone` (klein/sky/ok/warn/err/gray/dark) plus `data-plain`. `data-status` maps to tones: published = ok, draft = warn, scheduled = sky, archived = gray, pending = klein. The status word is always text |
| `.btn` | `data-variant=primary\|danger` | `--primary/--dark/--ghost/--danger/--soft/--sm/--icon` | Keep `data-variant` and add `dark\|ghost\|soft`; add `data-size=sm` and `.btn--icon` |
| `.bar` | 5% `data-width` buckets | `.bar > i` with inline width | Keep the buckets; inline widths are never ported |
| `.toast` | white, with an inline-start rule | midnight pill with an icon | Restyled in place |
| `.tabs` vs `.seg` | underline links | segmented buttons | Same segmented look for both. `.tabs` = server links (aria-current); `.seg` = client radiogroup or tablist |
| `table.data` vs `.tbl` | | | Keep `table.data` and give it the `.tbl` look |

**Viewport media queries.** Only the shell uses one (a 900px breakpoint). Every content layout uses container queries.

**Literal colours.** The dormant dark palette is deleted. A test that forbids colour literals outside the token blocks keeps the "one-block palette swap" property it used to guard.

**Escapes.** The minifier refuses a backslash outside a string, so there are no backslash escapes outside strings (scripts/minify-css.mjs).

### 1.3 Fonts

**Faces.** admin.css copies global.css's `@font-face` set exactly:
- Archivo variable latin, with its unicode-range;
- Almarai 400, 700 and 800, each in latin and arabic, with the same ranges;
- `Archivo Fallback`;
- the per-weight, per-script `Almarai Fallback`.

Today admin.css declares only Almarai 400 and 700 Arabic, under a range wider than the files.

**Arabic stack.** `--ad-font-ar` is `'Almarai','Almarai Fallback','Archivo',system-ui`, which equals `--bs-font-ar`. Authors therefore proof Arabic, including 800 headings, in the face visitors see.

**Other rules**
- No Google Fonts (Pillar 2; `font-src 'self'`).
- No preloads: /admin is exempt from the font budget (§6).
- A test asserts that the admin.css and global.css `@font-face` blocks are identical, matching docs/fonts.md's "both stylesheets change together".

### 1.4 Motion

**Compositor-only (Pillar 2).**
- The drawer slides on translateX; the modal uses translateY plus scale; the savebar uses translateY; toasts use opacity plus translateY.
- The switch knob, sortable lift and spinner animate too.
- Dialog entry uses `@starting-style` and `transition-behavior: allow-discrete`, with no JS.

**Reduced motion.** One `prefers-reduced-motion: reduce` block turns off every transition and animation and `scroll-behavior`. Spinners become a static "Saving…".

**Charts** render in their final state.

### 1.5 RTL and the admin language

- The chrome stays `lang=en dir=ltr` (owner decision).
- Arabic inputs and cells keep `lang=ar dir=rtl` in Almarai (admin.css L705–718).
- All new CSS uses logical properties. The mockup's physical leftovers are fixed:
  - the switch knob gets a translateX plus a `[dir=rtl]` mirror;
  - the select chevron gets a `[dir=rtl]` position;
  - the savebar, role, tag and section paddings become logical;
  - the drawer opens from the inline end;
  - timeline offsets move into SVG.
- User-authored strings in lists get `dir="auto"`.

### 1.6 CSP-safe techniques for each dynamic style

These follow §3 Pillar 1 and §7: style-src is nonce-only, React style props are forbidden, and CSSOM is used only after hydration.

| Dynamic style | Technique |
|---|---|
| bar and progress widths, score bars | `.bar-fill[data-width]` 5% buckets, or SVG `<rect width>` |
| chart geometry (lines, areas, bars, donut arcs, rings, gauges) | SVG presentation attributes: `d`, `x/y/width/height`, `r`, `stroke-dasharray`, `stroke-dashoffset`, `transform` |
| series colours, avatar colours | classes `.ch-s1..7` (theme-following) and `[data-tone="0..7"]` (stable hash of the user id) |
| clip timeline window | SVG rect in a 0–1000 viewBox |
| icon size, thumbnails | `width`/`height` attributes |
| column widths, number-input width, required asterisk | classes (`.w-thumb`, `.w-num`, `.in--num`, `.req`) |
| colour swatches | SVG `<rect fill="#hex">`; the hex is Zod-validated |
| theme preview on the admin itself | `documentElement.style.setProperty('--bs-klein', …)` after hydration, only when the palette passes the gate |
| preview iframe scale and width | `--pv-scale` and `--pv-w` via CSSOM after hydration |
| sortable drag offset | CSSOM `transform` during pointer move |
| loading-screen replay | custom properties via CSSOM inside the preview modal |
| dialog, drawer and savebar entry | `[open]`, `@starting-style` and classes |

**Hard rules**
- No `style={{}}` in src/components/admin, enforced by a test.
- No runtime `<style>` injection.
- No `data:` or `blob:` image previews. img-src has neither, so uploads show the file name, size and dimensions until the server returns a `/_image` thumbnail.
- No `<script>` in src/pages/admin/**.

### 1.7 Icons

- The ~78 mockup icons (24 viewBox, 1.8 stroke, round caps) are ported into one same-origin sprite, `public/styles/admin-icons.svg`, as `<symbol id="i-…">` with `stroke=currentColor` and no style attributes.
- `Icon.astro` and `Icon.tsx` emit `<svg class="ic" width height aria-hidden="true" focusable="false"><use href="/styles/admin-icons.svg#i-name"/></svg>`.
- That costs zero JS and one cached request, and is allowed by `'self'`.
- A test parses the sprite, keeps the `IconName` union in step with it, and rejects any `style=`.

### 1.8 Contrast audit and forced colours

**scripts/contrast-audit.mjs**
- Replace `A_LIGHT`, `A_DARK` and `ADMIN_PAIRS` with `A_V2` and `ADMIN_V2_PAIRS`. These cover:
  - **text:** ink, dim and dim2 on card, bg, surface-2 and preview; dim on primary-soft-bg; white on primary and on hover; primary on card and both softs; each badge text on its solid soft; notes; side text and side label on midnight; white on midnight; code on midnight; white on tone 0–7; count pill (#2D2F35).
  - **non-text (3:1):** control border on card, bg and surface-2; focus on card, bg and surface-2; focus-dark on midnight; primary vs card (switch on); series 1–7 on card and bg; the ok, warn and err dots on midnight.
- Add `THEME_PAIRS`, read from `packages/theme/pairs.json`. The runtime theme gate reads the same file, so CI and the save-time gate cannot drift.

**Forced colours.** `@media (forced-colors: active)` gives badges and selected rows real borders. Focus uses `outline`, never box-shadow.

## 2. Component library

### 2.1 Layers and file layout (a new §8 convention)

- **Server primitives** (Astro, zero JS): `src/components/admin/ui/`
  - `Sidebar`, `Topbar`, `Crumbs`, `PageHead`
  - `Card`, `Badge`, `Avatar`, `Icon`, `Kpi`, `Note`, `EmptyState`
  - `StatRows` (`dl`), `Timeline` (`ol`), `ListRow`
  - `LinkTabs`, `LinkChips`, `ServerTable` + `Pager` (links)
  - `BarList`
  - `charts/{Spark,Line,BarsV,Donut,Ring}.astro` plus `ChartFigure`, with pure geometry in `src/lib/admin/charts.ts`
- **React kit** (`admin-ui` chunk): `src/components/admin/kit/`
  - `Modal`, `Drawer`, `DataTable` (+`BulkBar`, `Pager`), `Tabs`, `Segmented`, `Chips`
  - `useSortable`, `StatusBadge`, `Avatar`, `ListRow`, `EmptyState`, `Note`
  - `SaveStatus`, `ErrorSummary`
- **Field kit**: `src/components/admin/fields/*`.
- **Island entries**: `src/components/admin/islands/Admin*.tsx`, e.g. AdminChrome, AdminPageEditor, AdminEntityEditor, AdminCollection, AdminMediaLibrary, AdminServices, AdminProjects, AdminTheme, AdminHeader, AdminFooter, AdminLoading, AdminSettings, AdminUsers, AdminQuickActions.
  - Each island's private code lives in `src/components/admin/screens/<name>/`.
- **Vanilla enhancers**: `src/lib/admin/client/` holds `enhance.ts`, `sortable.ts`, `dashboardCustomize.ts`, `confirmForms.ts` and `previewBridge.ts`. AdminLayout's single `<script>` imports `enhance.ts`, which lazy-imports a module per `[data-enhance]` attribute.
- **Server first.** Anything without client state is server-rendered with GET-param controls and costs 0 KB JS. That covers the dashboard widgets, stats, health, activity log, release history, forms overview and search.

### 2.2 Shell

**Sidebar** (server-rendered)
- The logo uses `astro:assets` `<Image>` of `src/assets/braiin-logo-white.png` at 104px, served through same-origin `/_image`. The mockup's `data:` logo is dropped.
- **Env pill** shows the real deployment, "LIVE", "STAGING" or "LOCAL", from a new `public.admin_environment()` definer function over `app.deployment`, cached per isolate. When the call fails the pill is hidden; it never guesses.
- Groups are `<p class="side__group" id>` plus `<ul aria-labelledby>`.
- Each link has an Icon, a label and a count, e.g. `<span class="cnt">4<span class="visually-hidden"> new</span></span>`.
- The current link carries `aria-current=page`, a Klein fill and weight 600, so colour is never the only cue.
- The footer user chip is `<a href="/admin/account" data-open="account">` with avatar, display name, role and a chevron. It works without JS.

**Mobile, below 900px**
- `<nav id="admin-side" popover="auto">` plus a topbar `<button popovertarget>` "Menu". That gives light dismiss, Escape and the top layer with zero JS.
- At 900px and up, CSS overrides the UA popover hiding so the sidebar sits static.
- This also fixes the mockup's lost navigation at 320px / 400% zoom (WCAG 1.4.10).

**Topbar**, left to right:
- the Menu button (narrow screens only);
- the breadcrumb `nav > ol`, with links and the current page marked `aria-current`;
- the search trigger `<a href="/admin/search" data-open="palette">Search anything… <kbd>⌘K</kbd></a>`;
- a "Maintenance on" warn badge, read from KV `getMaintenanceState` as a boolean only. It is a link to General#maintenance for maintenance.manage holders and plain text for everyone else;
- the bell `<button aria-label="Notifications, N unread">` with its dot;
- View site `<a href="/" target="_blank" rel="noopener">` with the visually hidden text "(opens in a new tab)".

**Layouts.** `app` | `flush` | `auth` | `bare`.
- `flush` is for editors: no page head, and the island renders the editor bar with the h1.
- `auth` is the split sign-in.

**PageHead.** h1 at 24/800, a plain-language sub-line, a right-aligned `actions` slot that wraps, a `badges` slot below the h1, and a `crumbs` override.

**Fixed parts.** The skip link "Skip to content" points at `main#content` (tabindex -1). The `#admin-toasts` region stays server-rendered.

**Shell state.** `src/lib/admin/shell.ts` `loadShellState()` runs on every Tier C render using Promise.all with head counts only:
- `me`: display name, initials and role;
- `environment`;
- maintenance on or off;
- nav counts, each computed only for links the role can see:
  - Leads: status new;
  - Job applications: new;
  - Site health: open issues, i.e. dashboard_attention blocker kinds plus any errors in the last 24 hours;
  - Tasks: overdue (once CRM lands);
- the unread notifications count;
- the pending-changes count (once REL lands).

### 2.3 Overlays

All overlays use native `<dialog>` and `showModal()`, which brings the focus trap, Escape, the top layer and focus return (confirm.ts precedent).

**Modal** (`.mdl`)
- An h2 at 18/800, a sub-line and a Close button.
- Initial focus goes to the first field; for destructive actions it goes to Cancel.
- Footer actions put the primary action last.

**Drawer** (`.drw`)
- Opens from the inline end at 560px (820px wide variant), full width under 600px.
- Sticky header and footer.

**Confirm.** `confirm.ts` is restyled and keeps Cancel first. A `[data-confirm]` enhancer makes server forms and buttons confirm without React.

**Toasts.** Policy unchanged: `ok`/`info` only, 4s, dark pill with an icon. Errors stay inline and persistent (`role=alert`). The mockup's warn and error toasts become inline `.note--warn`/`--err` or disabled-with-reason states.

### 2.4 Data display

**DataTable**
- Server pagination at 25 rows, with "x to y of n" in a live region and numbered pages marked `aria-current`.
- Toolbar with search and chips or a segmented control.
- The title cell holds a real link with a stretched hit area. There is no `tr onclick`.
- Row actions show on hover **and** `:focus-within`.
- Optional selection: a "Select <title>" checkbox per row, a tri-state "Select all on this page", and a midnight bulk bar (`role=region`, count announced). Used on Media, Redirects, Projects and Testimonials.
- Numeric columns are tabular and end-aligned.
- Empty state and inline error.

**Charts**
- `<figure>` holds the SVG (`role="img"`, labelled by the caption plus a one-line summary) and a `<details>` "View as table" with a real `<table>`.
- The second series is dashed, so colour is never the only cue (1.4.1).
- No values live only in a hover.

**KPI.** Label; tabular value; a delta pill (▲/▼/•) with visually hidden "vs the previous N days"; a spark marked aria-hidden. When there is not enough history, the delta shows "—".

**Others**
- Badge: dot plus text.
- Avatar: initials on `data-tone`.
- EmptyState: icon tile, title, text, action.
- Note: info, warn, ok, err.
- Timeline and StatRows.
- ListRow: hidden rows are dimmed **and** labelled "Hidden".

### 2.5 Interaction primitives

**Tabs.** The ARIA tabs pattern: roving tabindex, arrow keys, Home/End. The tab syncs to `?tab=` via `history.replaceState`, and the server renders the active tab from the URL so there is no flash.

**Segmented.** A radiogroup, used for:
- EN | العربية | Both;
- device;
- the 7/30/90 range (links on server screens).

**Chips.** Toggle buttons; filters behave as radios; counts are visually labelled.

**Sortable core** (vanilla, also used by React)
- A handle `<button>` "Reorder <name>".
- Keyboard: Space lifts, arrows move, Space drops, Escape cancels. Each step is announced in a live region, e.g. "Hero, position 2 of 9".
- Pointer drag uses pointer capture, a CSSOM translate, midpoint insertion and auto-scroll.
- Multi-list groups support dashboard columns, with ArrowLeft/Right between columns.
- Visible Move up / Move down (and "Move to the other column") buttons are always present, for WCAG 2.5.7.
- The handle is 44px; every target is at least 24px (2.5.8).

### 2.6 Field kit v2

The existing id pins (`f-<name>[-en|-ar]`) and labels stay, so `adminFields.spec` keeps passing.

**Every field**
- A real `<label for>` or `<legend>` at 12.5/700. The right side of the label row carries meta: a "142/160" counter or "3 of 4" items.
- The required `*` is in err-text, with visually hidden "required".
- The hint (dim2) is linked by `aria-describedby`.
- Errors come from API `issues[].path`: `aria-invalid`, an inline message, and an ErrorSummary with links. A link that targets the hidden language switches that tab first.

**bilingual / prose**
- Both inputs stay in the DOM; the inactive one is `hidden`.
- An EN | AR segmented control sits in the label row.
- An editor-wide language context offers EN, AR or **Both**. Both is the side-by-side `.row-2`, for translators.
- **AR-completeness cue.** When AR is empty on a required bilingual field, the AR segment shows a warn-text dot (#B54708, which meets 3:1) and its accessible name becomes "Arabic (missing)". The editor bar shows the text "Arabic missing: N" and jumps through the gaps.
- For `prose`, the AR half may lag: a neutral cue reads "Arabic not written yet".
- **Stale-translation note.** When EN differs from the built-in text but AR still equals the built-in AR, a note reads "Arabic still shows the built-in text."
- Server Zod remains the gate (Pillar 3; §8).

**checkbox** renders as a switch: `button role=switch aria-checked` with a visible label. multiSelect stays as checkboxes.

**color** (new)
- Native `input type=color` plus a hex text input (`^#[0-9a-fA-F]{6}$`, monospace uppercase).
- Swatches are buttons with `aria-pressed`, painted with an SVG rect.
- An optional contrast line, e.g. "White text on it: 10.6:1 ✓".

**range** (new). `input type=range`, an `<output for>` and a suffix, with bounded steps.

**chips** (tags v2)
- Chips with "Remove tag X" buttons; Enter or comma adds; max items enforced.
- A bilingual variant is used for keywords.

**accent** (new)
- Replaces the mockup's HTML "Aa" highlight.
- Linked to its sibling bilingual text: per language, "Highlight in Klein blue from word [select] to word [select]", or "from word … to the end" for `accentFromEn/Ar`. A live preview line shows the result.
- Words are tokenised exactly like the public `splitAccent()`. The range clamps when the text shrinks, and "No highlight" is an option.
- Writes AccentSchema ranges (packages/schemas/media.ts). No HTML is ever stored (Pillar 1).

**link** (new)
- `{label bilingual, href}`.
- The page picker draws on `src/lib/admin/linkables.ts`: published pages plus the code routes `/`, `/about`, `/portfolio`, `/portfolio/all`, `/services`, `/contact`, `/join`, `/creative-knowledge`, every service and project, the legal pages, and each page's anchors. Labels come prefilled in EN and AR.
- A custom link must be site-relative or https.

**slugRelation** (new). An ordered multi-pick by slug, e.g. `selectedWork.cardSlugs` over featured projects.

**media v2**
- A tile thumbnail from a server `/_image` URL, with Choose / Remove.
- The picker is the media grid: search, Images | Videos, and **Upload in place** with alt text in EN and AR.
- Double-click or Enter picks.
- An alt-status badge, e.g. "No Arabic alt".

**clip v2**
- The source is a `/media/*.mp4` from a code registry with durations (Stream after KAN-20).
- Start and end are number inputs.
- An SVG timeline (aria-hidden) plus the text "6.2 s to 7.9 s of showreel.mp4 (18.4 s)".
- The ≤30 s rule is shown as a hint.

**repeater v2**
- Item cards with a Sortable handle and a computed title.
- "Remove <label> N" (trash icon).
- Move up / Move down are kept.
- Add, disabled at the maximum with "At most N".
- Long items can collapse.

**richtext**
- The `.rich` toolbar (B, I, H2, H3, lists, link, clear). Links open in a dialog, never `prompt()`.
- Lazy-loaded with `React.lazy` from an `admin-rich` chunk, with a skeleton fallback.
- Tiptap JSON is still sanitised on write and on render (Pillar 1).

**sectionContent**
- Typed fields arrive prefilled with the **built-in copy** (AV-23), plus "Reset to built-in". Only differences are stored, through formPayload.
- "Advanced (JSON)" stays behind an Admin-only disclosure.
- SECTION_ADVANCED_ONLY shrinks to `hero.intro`. That key becomes a typed switch on the Loading screen (AV-30).

**Save hook: `useEntitySave(resource, id)`.** It is the one place that knows the save mode.
- **Live mode** (until REL): an explicit "Save changes" button, sending version, with a 409 banner.
- **Draft mode** (AV-24):
  - debounced autosave: 800 ms, and on blur or section switch;
  - `base_version`, with a SaveStatus line: "Saving…", "Saved as draft 12:04", "Couldn't save, retry";
  - a 409 conflict banner offering "Reload their version" (REL decides overwrite semantics);
  - dispatches an `admin:pending` CustomEvent for the savebar.

### 2.7 Command palette (inside AdminChrome, `client:load`)

**Opening and markup**
- Opens on ⌘/Ctrl+K anywhere, on "/" when focus is not in a field, or from the topbar trigger.
- A native modal `<dialog aria-label="Search the admin">` holds `input role=combobox aria-expanded aria-controls aria-activedescendant` and a grouped `role=listbox`.
- Arrow keys, Enter, Escape; focus returns to the trigger.

**Sources**
1. Nav destinations, passed as props from `visibleNav(role)`. These are instant.
2. Cap-filtered quick actions. They *navigate* with an intent parameter, for example "New project" goes to `/admin/portfolio?new=1`. They never execute.
3. `GET /api/admin/search?q=`, a new defineAdminRoute JSON wrapper around `searchAdmin()`:
   - same `cleanQuery`, `escapeLike`, one ilike column per entity, 5 per entity, per-entity caps;
   - **leads, contacts and job applications are never indexed** (globalSearch.ts L35–38; §3);
   - fixes the team and certifications `name` jsonb column to `name->>en`;
   - the client debounces at 200 ms, needs 2 characters, and aborts stale requests.
4. "See all results" goes to /admin/search, which stays as the no-JS fallback.

A WAF rule on the endpoint follows once a zone exists.

### 2.8 Notifications drawer

**A derived feed.** There is no event table (§10: no email).

**Endpoints**
- `GET /api/admin/notifications` returns at most 30 items, cap-filtered on the server.
- `POST /api/admin/notifications/seen` sets `admin_user_prefs.notifications_seen_at`. The unread count rides shell state.

**Sources**
- New leads, as "New inquiry from <name> (<service>)", using only fields the lead list already shows, for leads caps and Sales.
- New job applications, as "New application for <role>" (role only), Admin only.
- Releases published, for all staff (REL).
- "Changes waiting for you to publish", for content.publish holders (REL).
- Scheduled today, for content caps.
- Maintenance turned on or off, for all staff.

Content Creator and SEO receive no lead or application items, not even counts (dashboard.ts rule; §3 Pillar 1).

**Drawer.** Rows are links. Clicking a row marks only that item visually and does not clear the dot for the others (fixes a mockup bug). The footer offers "Mark all as read". Empty state: "No notifications".

### 2.9 Account drawer and /admin/account

The drawer header shows the avatar, name, email and role badge. Its rows:
- **Edit profile.** Display name up to 80 characters, through `PATCH /api/admin/me`. That calls a SECURITY DEFINER `app.update_my_profile()`, because profiles is admin-write only, and is audited.
- **Change password.** Current, new and confirm, through `POST /api/admin/me/password`. It re-authenticates first, and that attempt counts toward the lockout (§3). It then calls updateUser, revokes other sessions, and is audited.
- **What I can do.** Plain-language lines from `src/lib/authz/capLabels.ts` for the session role, plus "Ask an Admin to change your access."
- **Notifications preferences.** A link.
- **Admin language.** "English" (read-only).
- **Sign out.** A CSRF POST.

The 2FA row is hidden until MFA exists. `/admin/account` is the no-JS page for the same forms.

### 2.10 Savebar and publishing UX (AV-24; consumes REL)

**Bar**
- A fixed bottom-centre midnight pill with a warn dot (8.27:1).
- Text: "You have unpublished changes", then a "12 changes" chip, then [Review], [Discard] and [Publish]. Publish appears only for content.publish holders (§5).
- SEO and Developer see "Waiting for an Admin or Content Creator to publish" and [Review]. Publishers also receive a bell item.
- The bar is `role=region aria-label="Publishing"` and sits after `main` in the DOM.
- `.content` gets `scroll-padding-block-end` equal to the bar's height, so focus is never obscured (2.4.11).
- Its first state is server-rendered. It updates on `admin:pending`, on window focus and on visibilitychange.

**Review drawer.** Pending changes grouped by entity, each showing who and when plus the changed field names. Per change: Open, Preview, and Discard where allowed.

**Publish modal**
- A summary, e.g. "12 changes across 4 pages, 2 services, theme".
- An optional note of at most 140 characters.
- A dry-run validation list with links, for example "Arabic title missing on Logo Design". Publish stays disabled until the list is clean; the server is the gate.
- A "Publish v15" confirmation.
- Success toast: "Published. The website now shows these changes." A conflict shows an inline error with a Review link.

**Discard.** A danger confirm: "Discard changes? Everything since the last publish will be reverted." The scope is REL's.

### 2.11 Bundle plan

**Today.** About 223 KB gz: `admin-ui` 165.2 (admin code, Tiptap and ProseMirror, zod) + `admin-vendor` 55.7 (react, react-dom) + facades. Budget ≤300 KB gz (§2 amendment, §6).

**Chunking** (astro.config.mjs `manualChunks`)
- `src/components/admin/screens/<name>/**` goes to `admin-screen-<name>`.
- Every other `src/(components|lib)/admin/**` module goes to `admin-ui`.
- `@tiptap|prosemirror|orderedmap|rope-sequence|w3c-keyname` plus RichText go to `admin-rich`, which is lazy.
- react, react-dom and scheduler go to `admin-vendor`.

Every name is `admin-*`, so `.size-limit.json` needs no edit per screen. Island facades are named `Admin*`, and one `Admin*.js` glob is added to both lists. A test enforces the naming, bans `<script>` in admin pages, and bans React style props.

**Per-page payload** falls, because the dashboard, settings and media no longer load Tiptap or every screen. **The measured total does not fall**: size-limit sums every matched file.

**Ledger** (estimates, gz)
- Adds: shell +1, overlays and palette +4, personal layer +3, kit +5, fields +6, dashboard +3, media +4, page editor +10, savebar +3, entity editors +6, collections +3, theme +4, chrome editors +5, settings +5, users +1. That comes to about +63.
- Removals: InsightsPanel −3, ReadOnlyPanel −2, MaintenancePanel −1.5, the old UsersPanel −2.5, the ResourceTable/Form/Singleton bodies replaced −6. That comes to about −15.
- **End state about 271–281 KB**, before CRM screens.

**Levers**
- L1: replace StarterKit with an explicit extension set matching the sanitiser in `src/lib/content/tiptap.ts`. Saves about 8–15 KB and also narrows what the editor can emit.
- L2: Not available: zod stays in the admin bundle, since the preview bridge must validate a Zod envelope (§3).
- L3: amend the budget; this is the owner item.

**Process.** Each PR reports its size-limit delta and updates the ledger in docs/admin-v2.md.

## 3. Information architecture

### 3.1 Sidebar

Derived from ROLE_CAPS: `NavLink` gains `icon`, `count?` and `match?: string[]`. Order: Overview, Content, CRM, Hiring, Growth, Appearance, Settings.

| Group | Item | Route | Visible when the role holds any of | Icon | Count | Also lights for |
|---|---|---|---|---|---|---|
| Overview | Dashboard | /admin | analytics.read, leads.manage, the Sales/CRM caps | home | | |
| Content | Pages | /admin/pages | pages.write, seo.entityMeta | pages | | /admin/sections/** |
| | Services | /admin/services | services.write, seo.entityMeta | layers | | /admin/disciplines/**, /admin/service-cases/** |
| | Projects | /admin/portfolio | portfolio.write, seo.entityMeta | briefcase | | /admin/sectors/** |
| | Creative Knowledge | /admin/blog | blog.write, seo.entityMeta | type | | /admin/categories/** |
| | Testimonials · Clients | /admin/testimonials · /admin/clients | portfolio.write | quote · star | | |
| | Team | /admin/team | blog.write | users | | |
| | FAQ (new) | /admin/faq | pages.write | note | | |
| | Numbers (statistics) | /admin/statistics | services.write | grid | | |
| | Certifications | /admin/certifications | services.write | tag | | |
| | Media library | /admin/media | media.write (full, meta) | image | | |
| CRM (CRM slices) | Leads · Contacts · Tasks | /admin/leads · /admin/contacts · /admin/tasks | leads.manage and the Sales caps | inbox · users · check | new · — · my overdue | |
| Hiring | Job applications | /admin/applications | applications.manage (Admin, J6; never in CRM) | hand | new | |
| Growth | Website stats | /admin/analytics | analytics.read | chart | | /admin/analytics/search (Search tab) |
| | Site health | /admin/site-health | siteHealth.view | shield | open issues | /admin/logs (Errors tab) |
| | Style-Finder | /admin/ai-questions | ai.editContent, ai.config | sparkle | | /admin/ai-styles, /admin/ai-config |
| Appearance | Theme | /admin/appearance/theme | theme.edit | palette | | /admin/themes/** |
| | Header | /admin/appearance/header | nav.edit, theme.edit | header | | /admin/navigation/** |
| | Footer | /admin/appearance/footer | nav.edit, settings.general | list | | |
| | Loading screen | /admin/appearance/loading | theme.edit, pages.write | loader | | |
| Settings | General | /admin/settings | settings.general, maintenance.manage | settings | | /admin/maintenance |
| | SEO | /admin/seo | seo.globalDefaults, seo.entityMeta (full), redirects.manage | seo | | /admin/redirects/** |
| | Forms | /admin/forms | settings.general | form | | |
| | Notifications | /admin/settings/notifications | any staff (personal) | bell | | |
| | Integrations | /admin/integrations | settings.integrations | plug | | |
| | Users & roles | /admin/users | users.manage | shield | | |
| | Activity log | /admin/audit | audit.view | history | | |
| | Backups & versions | /admin/backups | export.backup, content.publish | db | | |

**Retired routes** are 302 server stubs (admin is noindex), so deep links from dashboard_attention, globalSearch and bookmarks keep working:

| From | To |
|---|---|
| /admin/sections/[id] | /admin/pages/<page>?section=<id> |
| /admin/service-cases/[id] | /admin/services/<service>?tab=case |
| /admin/disciplines | /admin/services |
| /admin/navigation | /admin/appearance/header |
| /admin/themes | /admin/appearance/theme |
| /admin/maintenance | /admin/settings#maintenance |
| /admin/logs | /admin/site-health?tab=errors |
| /admin/analytics/search | /admin/analytics?tab=search |
| /admin/redirects | /admin/seo?tab=redirects |
| /admin/categories | /admin/blog?tab=categories |
| /admin/sectors | /admin/portfolio?drawer=tags |

A test checks that every nav href, globalSearch target and attention link resolves to a page file.

**Breadcrumbs.** Derived from the nav, with a per-page override for entity names, e.g. "Services / Branding / Logo Design". The names are read server-side under RLS.

### 3.2 What each role sees

- **Admin**: everything.
- **Content Creator**:
  - Dashboard and all of Content;
  - Website stats and Style-Finder (Questions and Styles);
  - Header (menu card only), Footer (links only), Loading (on/off only);
  - Notifications.
- **SEO**:
  - Dashboard;
  - Pages, Services, Projects and Creative Knowledge, read-only except the SEO drawer or tab;
  - Media (meta only);
  - Website stats including Search;
  - Settings: SEO, Integrations, Notifications.
- **Developer**:
  - Dashboard;
  - Leads, while it holds leads.manage;
  - Website stats and Site health;
  - Theme, the Header layout card, Footer settings and Loading timing;
  - General, including maintenance and page visibility;
  - Notifications, Activity log, and Backups (export only).
- **Sales**: Dashboard (lead, pipeline and task widgets), CRM (Leads, Contacts, Tasks) and Notifications. No content, settings, exports or savebar. The palette offers nav plus CRM actions only; leads and contacts are never indexed.

## 4. Screen-by-screen port (non-CRM)

### Dashboard (/admin, server-rendered; AV-09)

**Head**
- "Good morning|afternoon|evening, <first name>", computed in Asia/Riyadh. The name falls back to the email's local part.
- Sub-line: "Here is how <PUBLIC_SITE_URL host> is doing. Last published <ago> (v<n>)." The release part appears once REL lands.
- Actions: Customize; View site; Edit homepage (pages.write) to /admin/pages/<home id>.

**Banners**
- Maintenance on, with Turn off for maintenance.manage, which jumps to General.
- Hidden pages.
- Placeholders live (a launch blocker).

**Widgets.** A server registry `src/lib/admin/dashboard/widgets.ts` loads only the visible widgets:

| Widget | Shown to | Content |
|---|---|---|
| `kpis` | analytics.read | "Page views, 7 days" with delta and spark, from `rollup_daily_pageviews`; "Arabic share". Lead-holders also get "New leads waiting", plus "Won this quarter" once CRM lands. Others get "Pages live" and "Services live" |
| `quick` | all | the user's quick actions |
| `views` | analytics.read | "Page views, last 30 days", EN and AR series. Lead-holders get a separate "Leads, 30 days" bar chart; there is no ×20 scaling |
| `leads` | leads caps | the 6 newest, safe columns only: name, service interest label, status, ago. No budget (§3 lead PII) |
| `attention` | content caps | the repo lists, with editor links |
| `health` | siteHealth.view | summary and failing checks |
| `activity` | audit.view | 5 latest, with names and plain language |
| `applications` | Admin | "New job applications" count and link (§10) |
| `pages` | analytics.read | top pages bars |
| `disciplines` | leads caps | leads-by-discipline donut |
| `publish` | REL | live version, last published, pending count, maintenance badge, "Publish now" for content.publish |
| `pipeline`, `tasks` | CRM | registered by the CRM slices |

Realtime and Team notes are omitted (deviations).

**Per-user layout**
- Stored in `admin_user_prefs.dashboard` as `{top, left, right, hidden}`. Zod drops unknown or forbidden ids on read; prefs never grant access.
- The default layout is per role.

**Customize**
- A vanilla enhancer on the server markup, using Sortable across columns.
- Each widget shows Move up, Move down, Move to the other column and Hide buttons.
- An "Add widget" drawer offers Left and Right; adding saves the prefs and reloads.
- "Reset" uses a confirm.
- Copy kept: "Drag widgets to reorder them or move them between columns. Use the eye to hide one."

**Quick actions editor** (AdminQuickActions)
- A library filtered by caps:
  - edit homepage, add project, add service, upload images, write a post;
  - edit the menu, change colours, edit SEO, add a redirect;
  - open leads, my tasks;
  - website stats, site health;
  - invite a user, maintenance, job applications;
  - publish changes, view site.
- Custom links: label up to 40 characters; href must be `/admin/…` or `https://…` (Zod refuses `javascript:` and `//host`); icon from a closed list; at most 8 custom and 12 total. External links open with `rel=noopener noreferrer`.
- Copy kept: "Tick the actions you want on your dashboard. Drag to reorder. Each person has their own set."

### Login, forgot and reset (AV-06)

**Layout.** Split, 1.1fr / 1fr.
- The art panel uses `<Picture>` of `stills/services/rider.jpg` under a midnight gradient. Quote: "From the brain to the real world." / "Everything on <host> is edited from here: pages, services, leads, and the look of the site." The brand comes from site_profile (§1).
- The panel shows the white logo (with an invert class), "Welcome back" and "Sign in to your admin."

**Form**
- Email, Password, "Keep me signed in" and "Forgot password?".
- **Keep me signed in.** A `remember` flag in LoginSchema. Checked gives today's 7-day `__Host-` cookie; unchecked gives a session cookie.
- Kept from today: generic errors, 423 lockout, `safeNext`, the CSRF hidden field and the no-JS form.

**Forgot password**
- `POST /api/admin/auth/forgot` gives one identical answer for every input, is rate-limited per IP and per email HMAC, requires CSRF, is audited, and calls `resetPasswordForEmail` with redirect to /admin/reset.
- `/admin/reset` verifies the recovery token on the server, sets the new password, signs out everywhere and goes to login.
- The middleware's pre-auth allowlist gains these four paths.
- SMTP is an owner item.

### Pages list (/admin/pages; AV-25)

**Cards** (`.grid--3`), each with:
- an icon tile;
- badges: status, plus Hidden (gray) and "Unpublished changes" (klein);
- the title;
- "<path> · N sections", using a PostgREST `page_sections(count)` embed;
- "Edited <ago>";
- a visibility eye for maintenance.manage holders only (immediate, confirmed);
- Open page (EN/AR);
- an Edit link (stretched).

**Template cards.** "Service page (template) · template for 28 services" and "Project page (template) · 12 projects" open AV-31.

**"+ New page"** is hidden until AV-33 (deviation).

### Page editor (/admin/pages/[id], flush; AV-25/26)

**Editor bar**
- Back.
- The h1 page title.
- Status badge.
- Segmented EN | العربية | Both.
- Visibility (Admin; the drawer reuses AV-13).
- SEO, which is the shared SeoDrawer: writable for Admin and SEO, view-only for Content Creator (§5).
- History.
- Open page.
- Publish (content.publish).
- SaveStatus.
- "Arabic missing: N".

**Sections column** (`aside aria-label="Sections"`). Each row has:
- a Sortable handle;
- the label, from a new `page_sections.label` (up to 60 characters, admin-only) or the type's friendly name;
- an uppercase type kicker;
- an eye switch ("Show <label> on the site"), which is a staged change;
- `aria-current` when selected.

Also in this column:
- **Add section**: a modal listing the types allowed on this page (a code map built on SECTION_TYPES), each with an icon and a plain description. Types already present or not allowed are shown disabled with the reason.
- **Rename**: a small dialog, never a prompt.
- **Delete**: Admin only (content.archiveDelete). Content Creator sees the hint "Hide it instead".

**Fields column**
- Header: label, type, and the anchor shown read-only from a code map (#selected-work…).
- Typed fields from sectionUi, prefilled with the built-in copy.
- Accent-range controls.
- Variant and placement selects where the type already has them. These are the only "Section settings".
- Collection link rows, e.g. "Managed in Testimonials · 3 items", "Numbers on this page", "Form fields → Settings › Forms".
- Honest notes on route data, e.g. "The button goes to Selected work while a project is featured, otherwise to Our Work."
- joinWhy and joinSteps items are edited here as a collection-style list with a drawer. The steps' time label is kept.

**Preview column** (AV-26)
- An iframe of the REL preview route at 1280 / 834 / 390, scaled with CSSOM. The language switch swaps the src.
- It reloads after each draft save, then jumps to the selected anchor. The highlight follows the selected section, and clicking a section in the preview selects it.
- Bar copy: "Live preview · Your edits are saved as drafts. Nothing changes on the site until you publish."

**Responsive**
- 1280px and up: 3 columns.
- 1024–1279px: Edit | Preview segmented.
- Below 1024px: sections become a select.

**Shortcuts.** ⌘S saves now.

**History drawer**
- A timeline of the entity's versions, each with who, when and changed fields (REL or `content_versions`).
- Preview and "Restore as a draft". Restore goes back through the resource kernel and is gated at publish.

**Deviations**
- No generic background, spacing, reveal or mobile-visibility settings.
- No editable anchors.
- No Custom HTML, Gallery, Video or Text blocks.

### Template editors (AV-31)

- Route: `/admin/pages/template/service|project?item=`.
- "Showing [picker]": services grouped by discipline in optgroups; projects as a flat list.
- The sections list holds the fixed template parts in read-only order.
- A "This service" / "This project" field group writes the entity drafts.
- "Shared text" is read-only, because the labels are code (SERVICE_PAGE_COPY and the case-study components), with a note.
- "Full editor" links to the full editor.
- The preview shows /services/<slug> or /portfolio/<slug>.

### Services (AV-14)

**Overview (/admin/services)**
- Disciplines in a sortable list: poster thumb; "01 · Branding · <AR>"; "8 services · <short>"; the first 4 services as pills plus "+N".
- An eye that changes status, with the warning "Hides its 8 services too" (RESTRICTIVE `services_discipline_published`).
- An edit drawer: name, short, blurb (each bilingual and required); card clip (path only, ≤30 s, EXC-009); poster.
- Add discipline.
- Admin-only Archive. If the FK restricts it, the message is "move its services first".
- Note copy kept.

**Discipline (/admin/disciplines/[id])**
- Services sortable within the discipline (the reorder endpoint is remapped inside the discipline's range).
- An eye per service, and "Open on site".
- "N leads" badges and a "Leads by service" bar chart, **for leads caps only**. They come from the new `GET /api/admin/leads/interest-counts`, an aggregate of counts with no PII.
- A "Card on the site" preview.

**Service editor (/admin/services/[id])**
- Head: Back, Open on site, Duplicate (a draft copy with slug -copy; the case is not copied), Archive (Admin).
- Badges, plus a "Visible on the site" switch.
- Tabs:
  - **Content**: name; slug (Admin and SEO; Content Creator read-only; a change proposes a 301 staged with the release); tagline (blurb, prose); intro; explanation (Tiptap — deviation from the mockup's textarea); deliverables (≤12); value cards (≤6, hint "Three cards work best"); hero clip and poster; an optional `show_skip_pill` switch.
  - **Case study**: the `service_cases` row. Linked project; client and sector read-only from the project; headline; context; problems (≤6); results (≤4). A preview card, and a sample banner with a "replace the sample" path.
  - **SEO**: the shared form.
  - **Leads**: leads caps only; safe columns; no budget.

### Projects (AV-15)

**List**
- Search over title and type; chips All / Featured / sector / Hidden.
- Columns: thumb, title plus type (AR below), service pills, sector, client, year, badges.
- **Manage tags** wide drawer:
  - Sectors (categories.manage);
  - Clients (portfolio.write, with the disclosure switch "Only switch this on when the client has agreed to be named"; §8);
  - "Projects are tagged with the 28 services → Services". There are no ad-hoc tags.
- Add project: an EN and AR title, slug and type, created as a draft. It never clones another project.

**Editor tabs**
- **Basics**: title, type, teaser, slug, sector, client, year, services (ordered), keywords (bilingual chips ≤6). Media card: poster, card clip, and the hero banner item, as two clearly labelled controls.
- **Case study**: lead, overview (summary), goal, result, scope (≤10), results (≤4), and the final film (role `final`: clip, duration label, poster). The testimonial card shows the linked testimonials row and its consent state, with "Add a quote" creating a draft with portfolio_id.
- **Breakdown & gallery**: breakdown repeater (kind, layout half/wide/third, image, caption) and a sortable square gallery grid ("Click an image to remove it. Order follows the grid." becomes a keyboard-sortable grid with remove buttons).
- **SEO**.

All of it saves through **one** `save_portfolio` call (or a composite REL draft).

A publish-requirements panel mirrors `assertPublishable`: bilingual title and type, poster, poster alt in EN and AR, no XX figures. The server remains the gate.

### Collections (AV-16)

AdminCollection is a list plus drawer:
- sortable rows with a thumb or icon, title and sub-line;
- badges: Hidden, Sample, Needs consent;
- Duplicate and Edit appear on hover **and** focus;
- empty state;
- Archive is Admin only.

**Per collection**
- **Testimonials**: quote, author and role (bilingual), project, client, photo, placements (Home, Our Work). Consent date and reference are required before Visible (`testimonials_consent_gate`). **Sample rows** show "This is a design sample. Replace the words and record consent to make it real." The one-save replace flow sends the words, consent and the cleared flag together (0028 sample lock).
- **Clients**: disclosure switch, marquee switch, logo (PNG; SVG refused), website.
- **Team**: name, role, portrait, LinkedIn, bio, "Show in the leadership slider", placeholder state.
- **Numbers**: value, suffix, label, placements and per-placement labels.
- **Certifications**.
- **FAQ** (new):
  - table `faq_items`: bilingual question and answer as plain text, sort, status, version;
  - loader `getFaq(locale)` feeds **both** FaqAccordion and the FAQPage JSON-LD, which keeps the contactFaq.ts invariant;
  - seeded from CONTACT_FAQ by gen-seeds, with no code fallback beyond a DB-outage fallback;
  - tag `faq:all` on the contact routes;
  - an empty FAQ hides the section and omits the schema.

### Creative Knowledge, Style-Finder and Job applications (AV-17)

- **Blog**: list and editor on the kit. Tabs: Content | SEO | Publishing, plus a Categories tab.
- **Style-Finder**: tabs Questions | Styles | Results & logic (ai.config).
- **Job applications**: Admin only. The list shows no PII. The drawer keeps the existing audited reveal and CV download untouched (§3, J6).

### Media library (AV-11/12)

**Toolbar**
- Search by display name or alt.
- Images | Videos.
- "Storage used: X MB of 1 GB": the sum of `size_bytes` against a quota constant (owner to confirm).

**Upload**
- A dropzone and an Upload button open a "Describe your images" dialog: one row per file with name, size and decoded dimensions (no local preview, because img-src has no `blob:`), alt EN and AR (both required), and tags.
- Upload progress uses XHR.

**Grid tiles.** 4:3, cover thumb from `/_image`, size badge, gradient caption, and a "No alt" badge where alt is missing.

**Drawer**
- Preview, file facts, alt EN and AR, tag chips.
- "Used in" links from `/api/admin/media/[id]/usage`.
- Download.
- Replace file: a new object; references survive.
- Delete: Admin only, disabled with the reason "This file is in use. Remove it from those places first."

**Videos tab.** A read-only code registry with the note "Videos are served from the site until video hosting is set up" (EXC-009).

**Copy changed** to: "Images are resized and compressed automatically for every screen."

**Pipeline (AV-11)**
- `POST /api/admin/media/upload` requires media.write at full level; SEO's meta-only access is refused.
- Size: ≤10 MB → 413.
- **Byte-sniff**: JPEG, PNG, WebP or AVIF only. SVG, GIF, animated WebP and HEIC are refused (415).
- Dimensions are parsed from the headers and must be ≤12000 px and ≤40 MP (decompression guard).
- Zod requires bilingual alt.
- The object key is `<tenant>/<uuid>.<ext>`; the file name is kept only as display_name.
- The service role writes to the public bucket `media`. On a failed insert the object is deleted; the upload is audited and capped per user per day.
- `media_assets` gets `provider='storage'` with a shape CHECK and the dimensions.
- `imageRef()` resolves storage rows to `{src: public URL, width, height}`, rendered by `<Picture>` through the cloudflare-binding image service at `/_image`, same origin. `image.remotePatterns` is pinned to the bucket path from the build env.
- Replace writes a new object, so cache keys change. A daily cron sweeps orphans.

### Website stats v1 (/admin/analytics, server-rendered; AV-10)

- Range links 7/30/90. Deltas show only when twice the range exists in rollups.
- **Overview tab**: KPIs (page views, Arabic share; leads and conversion for leads caps); a line chart of EN vs AR; a language donut; top pages bars.
- **Pages tab**: a table.
- **Search tab** (analytics.search): the existing data.
- Sources, Audience, Conversions, Realtime, Goals and the GA tab come later.
- Copy changed: "First-party stats from visitors who accepted analytics cookies." (§7)

### Site health v1 (/admin/site-health; AV-10)

- **Summary ring**: the score is field vitals 50% plus checklist 50%, labelled with that formula; there is no uptime data.
- **Tiles**: LCP, INP and CLS p75; errors in 7 days; checklist ok/total.
- **Overview tab**: the checklist, grouped:
  - Content: placeholders live, missing alt, missing consent, links to hidden pages;
  - SEO: missing AR meta, default descriptions;
  - Speed: p75 over budget;
  - Errors;
  - Security: facts read from code constants;
  - Backups: last export-backup outcome from audit;
  - each failing row deep-links to its fix screen.
- **Speed tab**: field p75 per path from the new `rollup_daily_vitals` (Pillar 4: dashboards read rollup_* only). Lab scores are labelled as CI-only.
- **Errors tab**: system_logs (logs.view; Clear is Admin-only logs.clear).
- **SEO tab**: readiness rows.
- Not built: Alerts, uptime and the broken-link crawler.

### Theme (/admin/appearance/theme; AV-27; theme.edit)

**Brand colours card**
- **Simple**: one colour plus 8 swatches. The palette is generated with the mockup's HSL rules, then gated.
- **Advanced**: primary, hover, accent, dark, light and paper, plus "Generate the rest from Primary".
- Each generated chip shows its contrast.
- A **gate failure** gives an inline error naming the pair, e.g. "White text on Hover is 3.2:1 — needs 4.5:1", with a "Use #0B6EB0 instead" suggestion that darkens the colour until it passes.

**Read-only facts**
- Typography: Archivo / Almarai only — self-hosted, subset, budgeted (§6). More fonts need a developer.
- Motion:
  - a marquee speed preset: slower, normal, faster;
  - "Reduced motion is respected automatically";
  - no smooth scrolling or parallax (design-port #44/#79).

**Other**
- Shapes come in AV-32. Custom CSS is never offered.
- "Reset to brand defaults" uses a danger confirm.

**Preview**
- The REL iframe, sent a `tokens` op for instant feedback.
- The admin itself previews the draft through CSSOM, only while it passes the gate.

**Delivery**
- `ThemeSettingsSchema` is compiled on the server into enum-keyed tokens (tightened ThemeTokensSchema), stored in `custom_themes.settings` and `tokens`.
- `/styles/theme.css?v=<version>` returns `:root{--bs-klein:…}` with `Cache-Control: public, max-age=31536000, immutable`, read through an anon policy on the active row's columns.
- BaseLayout and AdminLayout link it **only when a non-default theme is active**, so the default case costs nothing.
- Pages carry a new ALWAYS tag, `site:chrome`.
- The admin wears the theme through `--ad-primary: var(--bs-klein, #0024BC)`.

### Header (/admin/appearance/header; AV-28)

**Menu items card** (nav.edit)
- A sortable list. Each row has a bilingual label, a link, a key star (single, is_key unique) and an eye.
- Delete is Admin only (`navigation_delete_admin`); Content Creator gets Hide.
- Add item drawer: "A page of the site" uses linkables with prefilled EN and AR labels; "Custom link" must be site-relative or https.

**Layout and behaviour card** (theme.edit). The bounded options, stored in `site_chrome.header`:
- logo size S/M/L, presets of `--bs-logo-w` that keep `--bs-header-h` and the `<Picture sizes>` in step;
- menu alignment start, centre or end;
- hide when scrolling down (switch).

**Read-only facts.** Sticky; transparent over the hero; turns solid after the hero so the menu stays readable; the EN↔AR switch always shows (Pillar 3); the small-screen menu stays the zero-JS `<details>`.

**Preview.** The REL iframe, using a `scroll` op for "After scrolling".

### Footer (/admin/appearance/footer; AV-29)

- **Basics** (settings.general):
  - copyright template with `{year} {brand} {place}`, bilingual; default "© {year} {brand}. {place}"; the brand comes from site_profile (§1);
  - style Light | Dark (new global.css variant with contrast entries);
  - show email;
  - show social icons (accounts are in General).
- **Columns** (nav.edit): up to 4, built from navigation heading rows (a migration makes `href` nullable for headings).
- **Legal links**: Privacy, Terms and Cookie policy shown **locked**: "Always shown — required by the Saudi data law (PDPL)".
- **Preview**: the REL iframe scrolled to the bottom.

### Loading screen (/admin/appearance/loading; AV-30)

**Settings**
- "Show the loading screen" writes the home hero section's `intro` as a typed switch. It stays under pages.write, Admin and Content Creator, as today.
- Style tiles (theme.edit, stored in `site_chrome.intro`) form a radiogroup: Logo over the video | Logo on black | None.
- Duration: 500–1500 ms, step 100, hint "The site rule: never longer than 1.5 s". The Zod maximum enforces it; there is no warning toast.
- Fade: 300–600 ms, step 50.

**Read-only facts**
- Once per visit, per tab.
- Skipped under reduced motion.
- Any tap, key or scroll skips it.

**Not built.** Tagline and progress bar (an LCP-candidate risk).

**Public side**
- Hero.astro emits `data-hold` and `data-fade` buckets, which global.css maps to `--bs-intro-hold` and `--bs-intro-fade`. The choreography stays derived (docs/hero-intro.md §1).
- `.intro--opaque` keeps `pointer-events:none`, so the consent click is never swallowed.
- The LCP logo keeps opacity .01.

**Preview.** "Play preview" opens the REL iframe with a preview-only `?intro=replay`.

### General (/admin/settings; AV-18)

**Site**
- Site name: `brand_name`, bilingual.
- Tagline: new, bilingual.
- Read-only facts:
  - default language English (x-default);
  - languages: English and Arabic, both always built (§2);
  - domain: from PUBLIC_SITE_URL, "Where the site lives";
  - timezone: Asia/Riyadh.

**Brand**
- Logo and logo for light backgrounds are read-only, with the note "The logo is part of the site build so the first screen paints fast" (Pillar 2; it is the home LCP element).
- Favicon and app icon are media pickers (new columns), wired to SeoHead icon links and a new `/manifest.webmanifest`.

**Maintenance**
- A status banner and Turn on, with a danger confirm: "Put the site in maintenance mode?".
- IP allowlist chips.
- A preview of the real 503 page.
- **Immediate; never staged.**
- Bilingual copy and the staff bypass come later.

**Page visibility.** Admin and Developer.

**Contact.** Email; phone (new); WhatsApp E.164 plus its display form; address (location, bilingual); map link (new, https).

**Social accounts.** A repeater: a network select from the allow-list, handle, link, "Show on the site" (new `visible`), sortable, max 8.

**Advanced** (a `<details>`)
- Legal name, founded year, locality and country (for structured data).
- Typed technical keys.
- Retention (≤90 days).
- Accepting job applications: Admin only, immediate.

"Reset demo data" is dropped.

### SEO (/admin/seo; AV-19)

**Pages tab**
- Rows for pages, services, projects and posts, via a new `GET /api/admin/entity-seo/list`.
- Columns: title Custom/Default; description Custom/Default; Index; Arabic complete. Every page has code defaults, so the column reads Custom vs Default rather than ✓/✗.
- Clicking a row opens the **SeoDrawer**:
  - bilingual title and description, with counters and the hint "150 to 160 characters works best";
  - share image, from the media picker, stored as `og_media_id`;
  - Index switch, confirmed;
  - canonical override and schema type under an Advanced section (SEO and Admin);
  - EN **and AR (RTL)** Google previews using the title template (brand-first `%brand% | %s`), the URL from PUBLIC_SITE_URL, and the copy "Add a description so Google shows your words instead of guessing."

**Redirects tab**
- DataTable plus drawer: RedirectWriteSchema with help text, status 301/302/308, refusals.
- The **Sync to edge** status line is kept (resourceSync.spec pins).
- Immediate, through KV.

**Site-wide tab**
- Title template, default title and description, default share image.
- Default robots, with typed confirmation for noindex.
- Read-only rows: sitemap and llms.txt (regenerated on publish), 8 JSON-LD types (CI-validated), hreflang (automatic), canonical (per language), AI crawler policy (code-owned).

**Later:** "Check for broken links".

**Access.** Admin and SEO write; Content Creator sees per-entity meta read-only inside the editors; Developer has none.

### Integrations, Forms, Notifications (AV-20)

**Integrations.** Tiles for GA4 (measurement id), Search Console (verification token, which SeoHead emits as a `google-site-verification` meta tag), Calendly (URL) and reCAPTCHA (site key).
- Statuses: "Set up" / "Not set up". There is no fake "Connected".
- **Secrets never live in the staff-readable row** (§7).
- A typed IntegrationsSchema replaces `record<unknown>`.
- Read-only for anyone without settings.integrations.
- Copy: "Connect the tools you already use. Nothing here is needed for the site to run."

**Forms.** A read-only overview of the two closed field sets:
- which fields are required;
- protections: the honeypot is always on, plus the public write limits (EXC-004);
- recruitment consent is versioned;
- links to the copy that is editable in the page editor (contactInquiry, joinApply).

**Notifications** (personal bell preferences): New inquiry (leads caps), New application (Admin), Changes waiting (publishers), Published, Maintenance.

### Users & roles (AV-21; users.manage)

**Table**
- Avatar, display name, "(you)", email (joined on the server through the service client, live-rechecked), role badge, Active/Removed, Last sign-in, a Locked badge.

**Edit drawer**
- Display name, role (5 roles once Sales exists), Can sign in.
- Warning: "A role change signs them out."
- Self-demotion and self-deactivation are refused (existing).

**Invite drawer.** Email, role, display name.

**Pending invites.** New endpoints: list; resend (inviteUserByEmail again); cancel (deletes the unconfirmed user and profile, refused once confirmed). Audited.

**Roles & permissions**
- **Read-only**, generated from ROLE_CAPS with plain-language CAP_LABELS groups.
- Cells: ✓ / View / Meta only / —. Sales appears automatically.
- Caption: "Roles are fixed and checked twice, on the server and in the database."

**Security facts.** Session length 7 days; 2FA later.

### Activity log (/admin/audit, server-rendered; AV-22)

- **Filters**: kind chips (Edits / Publishing / Leads / Users / Settings) map to action-prefix sets on the server; plus a bounded `q`; 25 per page.
- **Who**: actor names from `app.staff_directory()`.
- **What**: plain-language sentences from `src/lib/admin/auditLabels.ts`. Titles are resolved per entity under the viewer's RLS, **never for leads or applications**.
- **Details**: changed field names only, never values.
- The chain-integrity banner is kept.
- Copy changed to: "Who changed what, and when. Kept permanently and tamper-evident."
- No export: the export lockdown applies and it is not in §5.

### Backups & versions (/admin/backups; AV-24)

- **Versions**: a release timeline ("v15 · live now", note, by, date) with Preview and "Roll back", which is content.publish and confirmed (REL).
- **Content export**: "Download all content as JSON" calls `GET /api/admin/export-backup` (Admin and Developer). It handles the 3-per-hour 429 and states the exclusions: "Leads, applications, consent records, audit and people's accounts are never in this file."
- **Disaster recovery card**: PITR 28 days, nightly encrypted dumps and the media mirror; restores run from the runbook.
- No restore button and no import (deviation).

## 5. Reflect and be reflected

For each admin screen: the public output it feeds, the cache tags its publish purges, and the gates to re-run on change.

| Admin screen | Public output it feeds | Tags purged on publish | Gates to re-run |
|---|---|---|---|
| Page editor: Home | `/`, `/ar`: getPageComposition('home') → SectionRenderer (Hero + withHomeIntro/withHomeData, ClientsMarquee, SelectedWork, StatBand, Testimonials, ServicesOverview, AboutIntro, SloganBand, HomeContact, SocialStrip) | `page:home` | lhci `/`, `/ar` (LCP = intro logo), hero-intro.e2e, home-sections.e2e, axe, served-html, capture |
| About | about.astro + withLeaders → AboutWho (LCP poster), LeadershipSlider, StatBand reach, SocialStrip; Person JSON-LD | `page:about` | lhci, layout-shift `/about`, `/ar/about`, about-page.e2e, JSON-LD, axe |
| Contact | ContactPage → hero preset, ContactInquiry, ContactChannels, FaqAccordion + FAQPage | `page:contact`, `faq:all` | lhci `/contact` (+ar), contact-page.e2e, JSON-LD FAQPage EN+AR, axe, CSP |
| Services page | ServicesPage → hero preset, StatBand services, ServicesOverview, ServiceExplorer, Hello | `page:services` | lhci `/services`, services-page.e2e, axe incl. `#events` |
| Our Work / All projects | workHero, proof, workIntro, projectGrid, clientsMarquee, cta / pageHead, projectCatalog, cta | `page:portfolio`, `page:portfolio-all` | lhci, layout-shift `/portfolio/all`, work-page, projects-catalog e2e, axe |
| Join | joinWhy, joinSteps, joinApply + ApplicationForm | `page:join` | join-page.e2e, lhci `/join`, axe, CSP |
| Services overview, Discipline | ServicesOverview cards (home, /services), ServiceExplorer, discipline clips | `disciplines:all`, `services:all` | lhci `/`, `/services`, media-bytes.e2e, services-page.e2e |
| Service editor | `/services/[slug]` ServicePage (banner h1 LCP, What, Value, CaseBlock, Hello, More, Fab); Service JSON-LD; SeoHead via entity_seo | `service:<slug>`, `services:all`, `service_cases:all` (+ redirects KV on a slug change) | lhci `/services/logo`, service-page.e2e, JSON-LD, sitemap/llms, media-bytes, axe |
| Projects | `/portfolio/[slug]` CaseStudyPage (banner poster LCP), ProjectCards (home, Our Work, All projects), facets | `portfolio:<slug>`, `portfolio:all`, `sectors:all`, `clients:all` | lhci `/portfolio/the-rider`, case-study, projects-catalog, layout-shift, JSON-LD, axe |
| Testimonials · Clients · Team · Numbers | Testimonials (home, proof), CaseQuote · ClientsMarquee, facets · LeadershipSlider, Person JSON-LD, blog authors · StatBand variants | `testimonials:all` · `clients:all` · `team:all` (+`blog:all`) · `statistics:all` | home, about, work e2e; JSON-LD; axe |
| FAQ | FaqAccordion and FAQPage JSON-LD (one loader) | `faq:all` | JSON-LD CI EN+AR, contactPage.spec parity, lhci `/contact` |
| Creative Knowledge | BlogIndex/BlogDetail, RSS, Article JSON-LD, sitemap, llms.txt | `blog:all`, `blog:<slug>` | seo-ci (rss, jsonld, sitemap), axe |
| Media (alt, replace) | every `<Picture>` of a media row (posters are LCP on About, Our Work, case studies) | `media:all` plus entity tags from media_usage. **Gap: `media:all` is missing on About, Our Work, All projects and case studies; add it or purge by usage** | lhci, layout-shift, axe (alt) |
| Theme | `/styles/theme.css?v=` linked by BaseLayout (and the admin) | `site:chrome` (new, ALWAYS) | contrast-audit THEME_PAIRS, axe on themed seed, lhci themed run (extra stylesheet), capture |
| Header | SiteHeader: navigation('header') + site_chrome.header | `nav:all`, `site:chrome` | header-footer.e2e, layout-shift (logo presets), lhci, axe, CSP |
| Footer | SiteFooter: footer tree + site_chrome.footer + site_profile | `nav:all`, `site:chrome`, `site:identity` | header-footer.e2e, contrast-audit (dark footer), served-html, axe |
| Loading screen | Hero.astro intro plate | `site:chrome` (and the home hero `page:home`) | hero-intro.e2e (default pin plus a bucket test), lhci `/`, `/ar`, reduced-motion axe |
| General (site_profile) | header alt, footer copyright and mail, ContactChannels, SocialStrip, Organization JSON-LD, `%brand%` titles, favicon and manifest | `site:identity` | served-html brand gate, JSON-LD Organization, seo-ci |
| Maintenance · page visibility | middleware 503 · 404/302 before the cache (KV snapshot); sitemap, llms and nav filters | none · `page:<slug>`, `nav:all`, sitemap/llms | maintenance.spec, middleware unit, sitemap.spec, visibility e2e |
| SEO per entity, SEO defaults, GSC token | SeoHead: title, description, OG, robots, canonical, verification meta | the entity's tag · `site:identity` | seo-ci (AR meta non-empty), JSON-LD, sitemap noindex exclusion |
| Redirects | middleware after a 404 (KV) | none | redirects.e2e, redirectRules.spec |
| Users, activity, backups, stats, health, notifications, account | none | none | admin axe and CSP only |

## 6. Schema added by this design

Migration numbers are assigned at merge time, after 0030, in coordination with the REL and CRM slices. Every new table has `tenant_id NOT NULL`, RLS ENABLE and FORCE, and `tenant_id = app.effective_tenant_id()` in every policy (§3, §8).

- **`admin_user_prefs`**
  - Columns: `user_id` (PK, FK profiles), dashboard jsonb, quick_actions jsonb, notifications jsonb, notifications_seen_at, version, timestamps.
  - RLS: self-only select, insert and update, for staff.
- **`app.staff_directory()`** (SECURITY DEFINER): returns `id, display_name, role`, to staff only, with no email.
- **`app.update_my_profile(display_name)`** (definer): self only.
- **`public.admin_environment()`** (definer): returns the env text, to staff.
- **`page_visibility`**
  - Columns: `page_id` (PK), visibility `public|hidden` (enum-ready), `hidden_target` `404|home`, version.
  - Write: Admin and Developer. Read: anon. A CHECK or RESTRICTIVE policy refuses hiding home.
  - Following the §2 capability-split amendment, this is its own table because Developer has no pages.write.
- **`page_sections.label`**: text, up to 60 characters, null allowed.
- **`faq_items`**
  - Bilingual question and answer, sort_order, status (content_status), version, actor columns.
  - Anon reads published rows. Writes use `app.can_write_content()`. Delete is RESTRICTIVE, Admin only.
  - Snapshots into content_versions; added to `app.publish_scheduled()`.
- **`site_chrome`** (singleton)
  - header, footer and intro jsonb; version.
  - Read: anon. Write: role in (admin, developer), because theme.edit and settings.general are the same role set today. If they diverge, the table must split (§2 amendment).
- **`navigation`**: `href` becomes nullable when `is_heading`, with a CHECK; footer only.
- **`site_profile`** gains:
  - `tagline` (bilingual);
  - `phone_display`;
  - `map_url` (https);
  - `favicon_media_id`, `app_icon_media_id`;
  - a `visible` flag on social items, at schema level.
- **`entity_seo.og_media_id`**, **`seo_defaults.default_og_media_id`**.
- **`custom_themes.settings`** jsonb, plus an anon select policy on the active row (columns tokens, version) and a tightened ThemeTokensSchema (enum keys).
- **`media_assets`**:
  - provider `storage` with a shape CHECK (key `^<uuid>/<uuid>\.(jpg|png|webp|avif)$`, width and height required);
  - `display_name`;
  - bucket `media`: public, 10 MB, image MIME allow-list, service-role writes only;
  - orphan sweep.
- **`rollup_daily_vitals`** (day, path, metric, p75, samples) with an `app.rollup_vitals()` pg_cron job.
- **Optional:** `services.show_skip_pill` and a portfolio search column.

## 7. Save semantics, screen by screen

| Screen or data | Mode | Who stages or saves | Who makes it live |
|---|---|---|---|
| Pages and sections, services, disciplines, cases, projects and children, testimonials, clients, team, FAQ, numbers, certifications, blog, categories, sectors, Style-Finder content, navigation items, header/footer/intro chrome, theme, site_profile identity, entity SEO and SEO defaults, media alt/tags/replace | **Draft** after AV-24 (live Save before it) | each entity's write cap | content.publish via the savebar (Admin, Content Creator) |
| Maintenance, page visibility | **Immediate, confirmed** | maintenance.manage | at once (KV, before the cache) |
| Redirects table | Immediate, with "Sync to edge" | redirects.manage | at once. A slug-change 301 is staged with its release (REL question) |
| Users, integrations, personal prefs, quick actions, notification state, site_settings (technical, retention), accepting_applications | Immediate | own caps | at once (not visitor-facing, or already live-checked) |
| New media upload · media delete | Immediate (unreferenced) · Admin, refused while used | media.write · media.hardDelete | when the referencing content publishes |
| CRM | Immediate (operational) | CRM caps | n/a |

## 8. Tests

**Update**
- `adminFields.spec`: pins kept; the new kinds added (switch, color, range, chips, accent, link, slugRelation); the AR "missing" accessible name.
- `resourceSync.spec`: Redirects inside SEO keeps `>Sync to edge<`, `data-sync` and `aria-live`.
- `adminSecurity.spec`:
  - nav per role including Sales;
  - counts only for capable roles;
  - Content Creator and SEO never see lead or application links or counts;
  - every nav href resolves;
  - redirect stubs;
  - the theme schema enum.
- `adminResources.spec`: faq and the new list projections.
- `sectionUi.spec`: fewer advanced-only keys; accent mapping.
- `formPayload.spec`: values equal to the default are omitted.
- `globalSearch.spec`: no lead, contact or application targets; jsonb name columns.
- `cacheTags.spec`: `site:chrome`, `faq:all`.
- `securityHeaders.spec`: `frame-src 'self'` only on /admin.
- `navCurrent.spec`, `maintenance.spec`, `contactPage.spec`, `minifyCss.spec`.
- `tests/authz/endpoints.spec.ts`: rows for every new endpoint across admin, content_creator, seo, developer, sales, anon and other_tenant (§9).

**Add, unit**
- `charts.spec`, `sortable.spec`, `relTime.spec`, `avatar.spec`.
- Icon sprite; admin font-face parity; no colour literal outside tokens; island naming, admin-script ban and style-prop ban.
- `notifications.spec` (PII gating), `quickActions.spec` (URL refusal), dashboard layout schema.
- Theme gate: property tests asserting that an accepted palette passes every pair.
- Media sniff and dimension fixtures: truncated, polyglot, SVG renamed .png, animated WebP, oversized.
- Preview bridge: origin and source checks; malformed envelopes are ignored.
- Health checklist rules.

**Add, pgTAP**
- `admin_user_prefs`, `staff_directory`, `update_my_profile`, `admin_environment`, `page_visibility`, `faq_items`, `site_chrome`, the media provider check and bucket policies, the vitals rollup.

**Add, e2e**
- **AV-01 harness**: the local auth hook in supabase/config.toml, CI-only staff users per role, and storageState per role.
- **csp.e2e**: authenticated admin routes per role. The inline-style check reads the **server HTML**, because CSSOM writes after hydration legitimately add `[style]`. Also: no securitypolicyviolation with the preview iframe, and public frame-src unchanged.
- **axe**: every admin route per role, under reduced motion, with drawers, modals and the palette opened.
- Keyboard journeys: palette; sortable lift, move and drop; repeater; dashboard customize; drawers return focus; savebar does not obscure focus; popover nav at 320px.
- Login, forgot and reset with no enumeration.
- Upload round-trip into CI storage.
- Hidden page gives 404/302 and leaves the sitemap.
- FAQ edit flows into the JSON-LD.
- Theme publish changes the themed public page with zero CSP violations.
- Header logo presets show no layout shift.
- Intro buckets keep their order.

**Visual**
- `tests/visual/admin-capture.e2e.ts` is an artifact from AV-01 onwards.
- AV-34 turns it into `toHaveScreenshot` baselines at 1440 and 390, with time and count regions masked.

## 9. Docs

- **docs/admin-v2.md**, a new decisions doc, in the style of docs/design-port-2026-09.md:
  - decisions numbered **AD-1…** (owner decisions keep A1–A5);
  - the bundle ledger;
  - the deviations register;
  - the planned IA for later-phase modules.
- **docs/hero-intro.md**: the timing buckets and the site_chrome source.
- **docs/fonts.md**: admin mirrors the faces.
- **architecture.md §4.3**: the bridge as implemented.
- **Runbook**:
  - the media bucket;
  - SMTP;
  - the CI staff fixtures, which must never reach seeds or production.

## 10. Edge cases

**Concurrency and failure**
- Concurrent draft edits get 409 conflict UI.
- If the preview route fails, the preview column shows an error with Retry; editing never blocks.
- If KV fails on maintenance or visibility, the panel reports it like `kvSynced` (never a silent 200).
- If the env RPC fails, the pill is hidden.
- If the palette is offline, an inline error shows.
- A session that expires mid-edit triggers the 401 redirect with `next`. Drafts limit the loss once REL lands.

**Cross-entity effects**
- A nav item pointing at a hidden page is dropped, and Site health flags it.
- A hidden page that a CTA links to is flagged in the health checklist.
- Deleting a discipline that still has services is refused with "move them first".
- Media used only in a draft relies on REL's usage including drafts; until then delete is refused only on live use.

**Content states**
- Sample testimonials can only be replaced in one save.
- Unpublishing a discipline warns that it hides its services.

**Limits**
- Storage quota full: "Storage is full. Delete unused files or ask to raise the limit."
- An accent range beyond the text length clamps, with a note.

**Roles and prefs**
- A role without caps gets an empty dashboard widget set, an honest empty state, and only the Notifications settings.
- Dashboard prefs that reference removed widgets are dropped silently.

**Sizing and reflow**
- Long titles truncate visually, with the full text available.
- Arabic fields in "Both" view wrap to one column below 32rem of container width.
- At 400% zoom, the popover nav and single-column content apply.

## Slices (design ids)

### AV-01: Admin test harness, island conventions and the decisions doc

**Depends on:** none · **Effort:** M

The ground every other slice tests against.
- Local custom access token hook in supabase/config.toml.
- A CI-only script that creates one staff user per role through the service role. It refuses to run when app.deployment = production and never touches seed.sql.
- A Playwright globalSetup that signs each role in (CSRF dance) and saves storageState, plus a Playwright project per role.
- csp.e2e:
  - covers authenticated admin routes;
  - the inline-style check reads server HTML instead of the live DOM.
- An axe ADMIN_ROUTES baseline per role on today's screens. Violations are fixed or recorded.
- tests/visual/admin-capture.e2e.ts as an artifact.
- .size-limit.json gains Admin*.js in both lists.
- A conventions test:
  - hydrated admin islands are named Admin* (or are on the legacy list);
  - no <script> in src/pages/admin/**;
  - no style={{ in src/components/admin.
- docs/admin-v2.md skeleton: AD decisions, bundle ledger, deviations register.

**Key files:**

- supabase/config.toml
- scripts/e2e-staff.mjs
- tests/e2e/fixtures/staff.ts
- playwright.config.ts
- .github/workflows/perf-seo-a11y.yml
- tests/e2e/csp.e2e.ts
- tests/a11y/axe.e2e.ts
- tests/visual/admin-capture.e2e.ts
- .size-limit.json
- tests/lib/adminConventions.spec.ts
- docs/admin-v2.md

**Tests:**

- each role signs in and lands on /admin
- CSP: no violation and no style= in the server HTML of the admin routes
- axe baseline on admin routes per role
- conventions spec

**Risks:**

- Auth-hook config drift between local and production
- Login lockout flakes in CI (use fresh users per run)
- Staff fixtures must never reach a real environment

### AV-02: Design system port: tokens, fonts, icon sprite, primitives restyle, contrast gate

**Depends on:** AV-01 · **Effort:** L

One coordinated rewrite of public/styles/admin.css.
- The v2 token table with the AA fixes:
  - dim2 #626A7F;
  - side label #919295;
  - badge text #067647 / #B54708 / #B42318 on solid tints;
  - control border #828B9E;
  - focus #024CFF, and #22A9FF on midnight;
  - chart series and avatar tones.
- @font-face mirrored from global.css: Almarai 400/700/800 latin + arabic, plus the per-weight fallbacks. --ad-font-ar puts Almarai first.
- Primitives restyled in place with every JS and test hook kept: buttons, inputs, switch, cards, table.data, badges with dots, toasts as dark pills, dialogs, tabs as segmented.
- Collisions resolved; grid modifiers use container queries; one reduced-motion block; forced-colors rules; the dormant dark palette removed.
- public/styles/admin-icons.svg sprite (the mockup's ICONS) with Icon.astro and Icon.tsx.
- scripts/contrast-audit.mjs A_V2 / ADMIN_V2_PAIRS.
- CLAUDE.md §2 amendment for the admin look.

**Key files:**

- public/styles/admin.css
- public/styles/admin-icons.svg
- src/components/admin/ui/Icon.astro
- src/components/admin/kit/Icon.tsx
- scripts/contrast-audit.mjs
- CLAUDE.md
- docs/fonts.md
- docs/admin-v2.md

**Tests:**

- npm run a11y:contrast with the new pairs
- admin font-face parity with global.css
- icon sprite spec: ids, viewBox, currentColor, no style
- no colour literal outside the token blocks
- cssSelectorLists: :has() lists are separate
- minifyCss covers admin.css
- axe admin baseline green
- visual capture before/after

**Risks:**

- Visual regressions on existing islands (tests pin hooks, not looks)
- The minifier refuses backslashes outside strings
- Older engines without :has(): cards degrade to padded, never broken

### AV-03: App shell and information architecture

**Depends on:** AV-02 · **Effort:** L

AdminLayout rewrite.
- Layouts: app / flush / auth / bare.
- The 256px midnight sidebar: groups, icons, live counts, env pill, user chip.
- Topbar: crumbs, search trigger, maintenance badge, bell button, View site.
- Skip link; popover sidebar below 900px; PageHead with actions and badges slots plus a crumbs override.
- nav.ts regrouped (Overview / Content / CRM / Hiring / Growth / Appearance / Settings) with icon, count and match. It stays derived from ROLE_CAPS.
- Every retired route becomes a 302 stub.
- dashboard_attention and globalSearch hrefs updated.
- src/lib/admin/shell.ts loads with Promise.all:
  - head counts, only for the links each role can see;
  - the maintenance boolean from KV;
  - the environment RPC;
  - me.
- The CRM group's links are added by the CRM slices in the same NavLink shape.

**Key files:**

- src/layouts/AdminLayout.astro
- src/components/admin/ui/Sidebar.astro
- src/components/admin/ui/Topbar.astro
- src/components/admin/ui/PageHead.astro
- src/lib/admin/nav.ts
- src/lib/admin/shell.ts
- src/lib/admin/globalSearch.ts
- src/pages/admin/sections/[id].astro
- src/pages/admin/service-cases/[id].astro

**Migrations:**

- 00NN_admin_environment.sql: public.admin_environment() SECURITY DEFINER, staff-only, returns production/staging/local from app.deployment

**Tests:**

- adminSecurity.spec: nav per role incl. a Sales fixture; counts gated; every nav, search and attention href resolves
- navCurrent.spec with match prefixes
- pgTAP admin_environment: anon and other_tenant deny
- e2e: popover nav keyboard and light dismiss; reflow at 320px; skip link
- axe and CSP on every role's shell

**Risks:**

- Count queries on every Tier C render (head counts only)
- Broken bookmarks (stubs plus a resolution test)
- The sidebar popover CSS override across engines

### AV-04: Overlays, toasts and the command palette

**Depends on:** AV-03 · **Effort:** M

- Modal and Drawer kit on native <dialog>.
- confirm.ts restyled, plus a [data-confirm] enhancer for server forms.
- Toast restyle (ok/info only; errors stay inline).
- The AdminChrome island (client:load).
- CommandPalette:
  - ARIA combobox/listbox;
  - ⌘K, / and the trigger;
  - nav destinations from props, cap-filtered quick actions that navigate with intent params, and GET /api/admin/search;
  - the endpoint is a defineAdminRoute JSON wrapper around searchAdmin. It never indexes leads, contacts or applications, and fixes the team and certifications jsonb name columns.
- /admin/search stays as the no-JS fallback.

**Key files:**

- src/components/admin/kit/Modal.tsx
- src/components/admin/kit/Drawer.tsx
- src/lib/admin/confirm.ts
- src/lib/admin/toast.ts
- src/lib/admin/client/confirmForms.ts
- src/components/admin/islands/AdminChrome.tsx
- src/components/admin/screens/chrome/CommandPalette.tsx
- src/pages/api/admin/search.ts
- src/lib/admin/globalSearch.ts
- src/lib/admin/quickActions.ts

**Tests:**

- globalSearch.spec: no lead, contact or application target; name->>en
- endpoints.spec rows for /api/admin/search (all roles incl. sales; anon and other_tenant deny)
- palette unit: filtering and keyboard
- e2e: ⌘K, arrows, Enter, Escape returns focus
- axe with the palette and a drawer open

**Risks:**

- Shortcut clashes inside text fields
- Query load per keystroke (debounce, abort, 5 per entity)

### AV-05: Personal layer: preferences, staff directory, notifications bell, account

**Depends on:** AV-04 · **Effort:** L

- The admin_user_prefs table (self-only RLS) and GET/PUT /api/admin/me/preferences with Zod.
- app.staff_directory() (names and roles, no email) and app.update_my_profile().
- PATCH /api/admin/me.
- POST /api/admin/me/password: re-authenticate (counts toward the lockout), update, revoke other sessions, audit.
- The derived notifications feed, filtered by caps on the server:
  - new leads, for leads caps and Sales;
  - new applications, Admin only;
  - scheduled today;
  - maintenance;
  - REL items register later.
- GET /api/admin/notifications and POST /api/admin/notifications/seen; the unread count lives in shell state.
- Notifications drawer, Account drawer, and the /admin/account no-JS page.
- CAP_LABELS in src/lib/authz/capLabels.ts.

**Key files:**

- supabase/migrations/00NN_admin_user_prefs.sql
- packages/schemas/adminPrefs.ts
- src/pages/api/admin/me/index.ts
- src/pages/api/admin/me/password.ts
- src/pages/api/admin/me/preferences.ts
- src/pages/api/admin/notifications/index.ts
- src/pages/api/admin/notifications/seen.ts
- src/lib/admin/notifications.ts
- src/lib/authz/capLabels.ts
- src/components/admin/screens/chrome/NotificationsDrawer.tsx
- src/components/admin/screens/chrome/AccountDrawer.tsx
- src/pages/admin/account.astro

**Migrations:**

- 00NN_admin_user_prefs.sql: admin_user_prefs (self-only RLS ENABLE+FORCE), app.staff_directory(), app.update_my_profile()

**Tests:**

- pgTAP: self-only prefs; another user sees zero rows; other_tenant and anon deny; staff_directory staff-only with no email; update_my_profile cannot change role, is_active or tenant
- notifications.spec: Content Creator and SEO get no lead or application items or counts; Sales gets lead items; Admin gets applications
- endpoints.spec rows
- password change: lockout interplay and other sessions revoked
- axe on both drawers

**Risks:**

- PII leaking through the feed (tested)
- The staff directory shows colleagues' names to all staff (documented AD decision)

### AV-06: Sign-in v2, keep me signed in, forgot and reset password

**Depends on:** AV-02 · **Effort:** M

- Auth split layout:
  - the rider still via <Picture>;
  - quote copy with the brand from site_profile and the host from PUBLIC_SITE_URL;
  - Welcome back / Sign in to your admin.
- remember flag in LoginSchema: a session cookie when off, the 7-day cookie when on (src/lib/auth/session.ts).
- POST /api/admin/auth/forgot:
  - identical answer for every input;
  - rate-limited per IP and per email HMAC;
  - CSRF and audit;
  - resetPasswordForEmail with redirect to /admin/reset.
- /admin/reset verifies the recovery token on the server, sets the password, signs out everywhere, and returns to login.
- The middleware's pre-auth allowlist grows by four paths.
- Kept: the existing error copy, lockout, safeNext and the no-JS behaviour.

**Key files:**

- src/pages/admin/login.astro
- src/pages/admin/forgot.astro
- src/pages/admin/reset.astro
- src/pages/api/admin/auth/login.ts
- src/pages/api/admin/auth/forgot.ts
- src/pages/api/admin/auth/reset.ts
- src/lib/auth/session.ts
- src/middleware.ts

**Tests:**

- no enumeration: same body and status for known and unknown emails
- lockout unchanged; CSRF required; rate limit
- remember on/off cookie attributes (__Host-, no Max-Age when off)
- csp.e2e and axe on login, forgot and reset; the no-JS submit works

**Risks:**

- SMTP not configured (owner item): the generic answer hides delivery failures, so the runbook must check it
- Supabase recovery token handling (PKCE vs hash)

### AV-07: Component kit: server primitives, SVG charts, DataTable, tabs, chips, Sortable core

**Depends on:** AV-02 · **Effort:** L

- Astro primitives: Card, Badge, Avatar, Kpi, Note, EmptyState, Timeline, StatRows, ListRow, LinkTabs, LinkChips, ServerTable + Pager, BarList.
- Charts: Spark, Line, BarsV, Donut and Ring with ChartFigure ('View as table'). Geometry is pure functions in src/lib/admin/charts.ts.
- React kit:
  - DataTable: server paging, stretched title link, selection, bulk bar, row actions on focus-within;
  - Tabs: ARIA, with ?tab sync;
  - Segmented (radiogroup) and Chips;
  - StatusBadge, SaveStatus, ErrorSummary.
- Vanilla Sortable core:
  - pointer, keyboard lift/move/drop/cancel with announcements;
  - multi-list support;
  - explicit move buttons;
  - useSortable hook.
- relTime (Asia/Riyadh, en-GB) and the avatar tone hash.
- ResourceTable re-implemented on DataTable with its props and hooks kept.

**Key files:**

- src/components/admin/ui/
- src/components/admin/ui/charts/
- src/lib/admin/charts.ts
- src/components/admin/kit/DataTable.tsx
- src/components/admin/kit/Tabs.tsx
- src/lib/admin/client/sortable.ts
- src/lib/admin/relTime.ts
- src/lib/admin/avatar.ts
- src/components/admin/ResourceTable.tsx

**Tests:**

- charts.spec: paths, scales, empty and one-point series
- sortable.spec: keyboard state machine, cancel, announcements
- relTime.spec and avatar.spec
- resourceSync.spec unchanged
- axe on screens using the kit

**Risks:**

- ResourceTable regressions
- Chart text alternatives drifting from the chart data (both built from one dataset)

### AV-08: Field kit v2 and the useEntitySave hook

**Depends on:** AV-07 · **Effort:** L

- New FieldKinds: accent (AccentSchema ranges and from-indices), link (with linkables picker), slugRelation, color, range, chips.
- Restyles:
  - bilingual/prose with EN | AR tabs, an editor-wide EN/AR/Both context, the AR-missing cue and the stale-translation note;
  - checkbox as a switch;
  - media v2 tile and picker;
  - clip v2 with the SVG timeline;
  - repeater with Sortable;
  - richtext lazy-loaded into the admin-rich chunk, with a link dialog.
- Inline error mapping from issues[].path, plus ErrorSummary.
- Built-in default plumbing: prefill, Reset to built-in, omit-when-equal.
- useEntitySave: live Save with version/409 now, draft mode later.
- SECTION_ADVANCED_ONLY shrinks.
- manualChunks gains admin-rich and admin-screen-*.

**Key files:**

- src/components/admin/FormField.tsx
- src/components/admin/fields/
- src/components/admin/RichText.tsx
- src/lib/admin/uiSchema.ts
- src/lib/admin/sectionUi.ts
- src/lib/admin/formPayload.ts
- src/lib/admin/linkables.ts
- src/lib/admin/useEntitySave.ts
- astro.config.mjs

**Tests:**

- adminFields.spec: existing pins kept, new kinds, the 'Arabic (missing)' accessible name
- formPayload.spec: accent, link, defaults omitted
- sectionUi.spec: advanced-only keys reduced
- e2e: keyboard repeater reorder
- size-limit ledger recorded in docs/admin-v2.md

**Risks:**

- Bundle growth (ledger and the Tiptap lever)
- The lazy RichText must not break SSR (immediatelyRender false plus a Suspense fallback)

### AV-09: Dashboard v1 with per-user layout and quick actions

**Depends on:** AV-05, AV-07 · **Effort:** L

Server-rendered widget registry over existing data.
- Widgets: kpis (rollups), quick, views (EN/AR line, plus separate lead bars for leads caps), leads (safe columns, no budget), attention, health summary (siteHealth.view), activity (audit.view, names and plain language), applications (Admin), top pages, disciplines donut (leads caps).
- Greeting in Asia/Riyadh; banners; role default layouts.
- Customize: a vanilla enhancer with Sortable across columns, Add widget drawer, Reset confirm.
- AdminQuickActions island: a library filtered by caps, plus custom links limited to /admin or https.
- The CRM and REL slices register pipeline, tasks and publish widgets later.

**Key files:**

- src/pages/admin/index.astro
- src/lib/admin/dashboard/widgets.ts
- src/lib/admin/dashboard/loaders.ts
- src/components/admin/ui/dashboard/
- src/lib/admin/client/dashboardCustomize.ts
- src/components/admin/islands/AdminQuickActions.tsx
- src/pages/api/admin/dashboard.ts

**Tests:**

- widget gating per role (Content Creator and SEO never get lead numbers)
- layout schema drops unknown and forbidden ids
- quickActions.spec refuses javascript: and //host
- e2e: keyboard customize (move, hide, add)
- axe dashboard per role; visual capture

**Risks:**

- Per-render query cost (only visible widgets load)
- Rollup gaps (deltas show —)

### AV-10: Website stats v1 and Site health v1 (server-rendered)

**Depends on:** AV-07 · **Effort:** L

- /admin/analytics:
  - range links and tabs Overview / Pages / Search (analytics.search);
  - KPIs with deltas when history allows; EN vs AR line; language donut; top pages;
  - consent-true copy.
- /admin/site-health:
  - summary ring (vitals 50%, checklist 50%) and tiles;
  - checklist with fix links;
  - Speed: per-path field p75 from the new rollup;
  - Errors: system_logs, Clear for Admin; /admin/logs retires here;
  - SEO readiness; Security facts from code constants.

**Key files:**

- src/pages/admin/analytics/index.astro
- src/pages/admin/site-health.astro
- src/lib/admin/health/checklist.ts
- src/pages/api/admin/site-health.ts
- supabase/migrations/00NN_rollup_vitals.sql

**Migrations:**

- 00NN_rollup_vitals.sql: rollup_daily_vitals(day, path, metric, p75, samples) + app.rollup_vitals() + pg_cron

**Tests:**

- checklist rules unit
- rollup pgTAP and p75 correctness
- gating: siteHealth.view, analytics.search, logs.clear
- axe; no raw web_vitals scan on the dashboard path

**Risks:**

- Checklist false positives
- Score credibility without uptime (the formula is labelled)

### AV-11: Media uploads pipeline (A5): Supabase Storage provider and image delivery

**Depends on:** AV-01 · **Effort:** L

- Public bucket media: 10 MB, image MIME allow-list, writes by the service role only.
- media_assets: provider 'storage' with a shape CHECK, plus display_name.
- POST /api/admin/media/upload:
  - requires media.write at full level;
  - byte-sniffs JPEG, PNG, WebP and AVIF; refuses SVG, GIF, animated WebP and HEIC;
  - parses header dimensions (≤12000 px, ≤40 MP);
  - Zod requires bilingual alt;
  - object key <tenant>/<uuid>.<ext>;
  - compensates on failure, audits, caps uploads per user per day.
- POST /api/admin/media/[id]/replace (new object, version check).
- GET /api/admin/media/[id]/download (attachment, nosniff).
- Delete also removes the object (Admin, refused while used).
- GET /api/admin/media/stats.
- imageRef() for storage rows; image.remotePatterns pinned to the bucket path from the build env; thumb_url via getImage → /_image.
- Daily orphan sweep.

**Key files:**

- supabase/migrations/00NN_media_storage.sql
- src/pages/api/admin/media/upload.ts
- src/pages/api/admin/media/[id]/replace.ts
- src/pages/api/admin/media/[id]/download.ts
- src/pages/api/admin/media/stats.ts
- src/lib/media/sniff.ts
- src/lib/media/dimensions.ts
- src/lib/media/resolve.ts
- src/lib/cron/daily.ts
- astro.config.mjs
- packages/schemas/media.ts

**Migrations:**

- 00NN_media_storage.sql: storage bucket media and policies; media_assets provider 'storage' + shape CHECK; display_name

**Tests:**

- sniff and dimension fixtures: truncated, polyglot, renamed SVG, animated WebP, oversized
- endpoints.spec: SEO meta-only cannot upload; Admin, Content Creator and Developer can; Sales, anon and other_tenant deny
- pgTAP: provider check and bucket policies
- e2e: upload round-trip in CI storage; storage image renders via /_image with no CSP violation

**Risks:**

- Supabase egress and image-transform costs (owner)
- remotePatterns per environment
- Worker memory on 10 MB bodies (stream it)
- Public bucket: unpublished images reachable by unguessable URL (documented)

### AV-12: Media library UI and the picker with upload

**Depends on:** AV-08, AV-11 · **Effort:** M

- /admin/media grid and toolbar: search, Images / Videos, storage meter.
- Dropzone and multi-file upload dialog: alt in EN and AR per file, XHR progress, no local previews.
- Detail drawer: preview, facts, alt, tag chips, Used in links, Download, Replace, Delete with reasons.
- The Videos tab is a read-only code registry (EXC-009).
- MediaField picker reuses the grid, with Upload in place.

**Key files:**

- src/pages/admin/media/index.astro
- src/components/admin/islands/AdminMediaLibrary.tsx
- src/components/admin/screens/media/
- src/components/admin/fields/MediaField.tsx

**Tests:**

- adminFields media pins ('Poster: choose')
- e2e: upload → appears → used in → delete refused while used
- axe on the grid, drawer and upload dialog; keyboard grid

**Risks:**

- Large grids (server paging)
- Alt-at-upload friction (bulk describe UI)

### AV-13: Hidden pages: page visibility enforced before the cache

**Depends on:** AV-07 · **Effort:** M

- page_visibility table: Admin and Developer write, anon read, home refused.
- Hidden paths, EN and AR, ride the site:maintenance KV snapshot. The middleware answers 404 (noindex, no-store) or 302 to home before rendering or the cache.
- sitemap, llms.txt and the navigation loader exclude hidden pages.
- PATCH /api/admin/page-visibility/[id]: immediate and confirmed, with kvSynced reporting. The old nav_visible route is kept as an alias.
- General › Page visibility card.
- The page editor's drawer reuses this later.

**Key files:**

- supabase/migrations/00NN_page_visibility.sql
- src/middleware.ts
- src/lib/http/maintenance.ts
- src/pages/sitemap.xml.ts
- src/pages/llms.txt.ts
- src/lib/data/navigation.ts
- src/pages/api/admin/page-visibility/[id].ts

**Migrations:**

- 00NN_page_visibility.sql: page_visibility (tenant, RLS ENABLE+FORCE, Admin+Developer write, anon read, home refusal)

**Tests:**

- middleware unit: hidden path → 404 or 302 before render; admin exempt; AR twin
- maintenance.spec: snapshot shape
- sitemap.spec exclusion
- pgTAP and endpoints.spec
- e2e: hide → 404 → show

**Risks:**

- The KV snapshot drifting from the table (sync reporting, as for redirects)
- Links to hidden pages (flagged by Site health)

### AV-14: Services area: overview, discipline detail, tabbed service editor

**Depends on:** AV-08, AV-12 · **Effort:** L

- /admin/services: sortable disciplines; eye with the 'hides its N services' warning; edit drawer; Add; Admin-only Archive.
- /admin/disciplines/[id]:
  - services sortable within the discipline, eye, open on site;
  - leads badges and bars for leads caps only, via the new GET /api/admin/leads/interest-counts (counts only).
- /admin/services/[id] tabs Content / Case study / SEO / Leads:
  - Add service modal (EN and AR name);
  - Duplicate as a draft copy;
  - slug editable by Admin and SEO, with a staged 301 proposal;
  - optional show_skip_pill switch.

**Key files:**

- src/pages/admin/services/index.astro
- src/pages/admin/services/[id].astro
- src/pages/admin/disciplines/[id].astro
- src/components/admin/islands/AdminServices.tsx
- src/components/admin/islands/AdminEntityEditor.tsx
- src/pages/api/admin/leads/interest-counts.ts
- src/lib/admin/uiSchema.ts

**Migrations:**

- optional 00NN_service_skip_pill.sql: services.show_skip_pill boolean default true

**Tests:**

- adminResources parity
- endpoints.spec: interest-counts gated (Content Creator and SEO 403)
- e2e: keyboard reorder; placeholder case banner
- axe on the tabs

**Risks:**

- Global sort_order remapped within a discipline
- The leads aggregate must stay PII-free

### AV-15: Projects area: list, tags drawer, tabbed editor over save_portfolio

**Depends on:** AV-08, AV-12 · **Effort:** L

- List: search over title and type; chips; thumbs; service pills.
- Manage tags drawer: Sectors; Clients with the disclosure gate; Services as a link.
- Add project modal.
- Editor tabs Basics / Case study / Breakdown & gallery / SEO:
  - role-specific media editors for hero, card clip, final film, breakdown and a sortable gallery, all in one save_portfolio call;
  - testimonial card with consent state;
  - publish-requirements panel.

**Key files:**

- src/pages/admin/portfolio/index.astro
- src/pages/admin/portfolio/[id].astro
- src/components/admin/islands/AdminProjects.tsx
- src/components/admin/screens/projects/
- src/lib/admin/resources.ts

**Migrations:**

- optional 00NN_portfolio_search.sql: generated search column for list search

**Tests:**

- save_portfolio round trip including children
- e2e: keyboard gallery reorder
- publish requirements mirror assertPublishable
- axe; adminResources parity

**Risks:**

- The composite save under drafts needs a REL contract
- The list projection's join cost

### AV-16: Collections and the FAQ table

**Depends on:** AV-08 · **Effort:** L

AdminCollection list and drawer:
- Testimonials: consent fields, placements, the one-save sample replace.
- Clients: disclosure and marquee switches.
- Team: leadership switch, placeholder state.
- Numbers; Certifications.

FAQ:
- faq_items table and resource.
- getFaq() loader feeding both FaqAccordion and the FAQPage JSON-LD.
- Seed rows generated from CONTACT_FAQ.
- faq:all on the contact routes.
- Empty FAQ hides the section and omits the schema.

**Key files:**

- supabase/migrations/00NN_faq_items.sql
- packages/schemas/faq.ts
- src/lib/data/faq.ts
- src/lib/content/contactFaq.ts
- src/components/sections/FaqAccordion.astro
- src/components/ContactPage.astro
- src/lib/sections/contact.ts
- scripts/gen-seeds.mjs
- src/components/admin/islands/AdminCollection.tsx
- src/pages/admin/faq/index.astro

**Migrations:**

- 00NN_faq_items.sql: faq_items (bilingual q/a, sort, status, version, actor; anon reads published; RESTRICTIVE delete Admin; content_versions snapshot; publish_scheduled)

**Tests:**

- pgTAP faq_items per role and other_tenant
- JSON-LD FAQPage EN and AR equals the rendered list
- contactPage.spec parity; contact e2e
- testimonial consent gate and sample flow; client disclosure gate

**Risks:**

- Visible FAQ and JSON-LD mismatch (one loader)
- Seed regeneration

### AV-17: Creative Knowledge, Style-Finder and Job applications on the kit

**Depends on:** AV-08 · **Effort:** M

- Blog list and editor: tabs Content / SEO / Publishing, plus a Categories tab.
- Style-Finder tabs: Questions / Styles / Results & logic (ai.config).
- Job applications restyle: list with no PII; drawer keeps the audited reveal and the CV download route unchanged; Admin only (J6).

**Key files:**

- src/pages/admin/blog/index.astro
- src/pages/admin/blog/[id].astro
- src/pages/admin/ai-questions/index.astro
- src/pages/admin/applications/index.astro
- src/components/admin/ApplicationsPanel.tsx

**Tests:**

- applicationsAdmin.spec unchanged (PII gates)
- axe; adminResources parity

**Risks:**

- Regressions in the audited PII flows

### AV-18: Settings › General with brand files, favicon and manifest

**Depends on:** AV-08, AV-13 · **Effort:** L

Typed General screen with these cards:
- Site: name, tagline, read-only facts.
- Brand: logos read-only; favicon and app icon pickers.
- Maintenance: immediate; MaintenancePanel merged in.
- Page visibility.
- Contact: phone and map link added.
- Social accounts: repeater with a visible flag.
- Advanced: legal, retention, technical keys, accepting applications (Admin).

Also:
- site_profile migration.
- SeoHead icon links and a /manifest.webmanifest route.
- The JSON textareas are replaced by typed controls.

**Key files:**

- src/pages/admin/settings.astro
- src/components/admin/islands/AdminSettings.tsx
- packages/schemas/siteProfile.ts
- src/lib/admin/uiSchema.ts
- src/components/SeoHead.astro
- src/pages/manifest.webmanifest.ts
- supabase/migrations/00NN_site_profile_v2.sql

**Migrations:**

- 00NN_site_profile_v2.sql: tagline jsonb, phone_display, map_url (https CHECK), favicon_media_id, app_icon_media_id

**Tests:**

- siteProfile schema spec (socials visible, max 8, host allow-list)
- served-html brand gate; seo-ci icons; manifest route
- maintenance stays immediate (kvSynced)
- axe

**Risks:**

- Mixing immediate and staged fields in one row (accepting_applications): needs a REL contract
- Icon transform formats

### AV-19: Settings › SEO: pages list, shared SEO drawer, redirects, site-wide defaults

**Depends on:** AV-08 · **Effort:** L

- Pages tab:
  - GET /api/admin/entity-seo/list merged with the PAGE_META defaults;
  - columns Custom/Default and Arabic complete;
  - the shared SeoDrawer: counters, og_media_id picker, index confirm, advanced canonical and schema, EN and AR Google previews.
- Redirects tab: DataTable and drawer, Sync to edge kept.
- Site-wide tab: template and defaults, robots with typed confirmation, read-only status rows.

**Key files:**

- src/pages/admin/seo.astro
- src/components/admin/screens/seo/SeoDrawer.tsx
- src/pages/api/admin/entity-seo/list.ts
- src/lib/seo/loadHead.ts
- supabase/migrations/00NN_entity_seo_og_media.sql

**Migrations:**

- 00NN_entity_seo_og_media.sql: entity_seo.og_media_id, seo_defaults.default_og_media_id

**Tests:**

- resourceSync.spec pins
- EntitySeoWriteSchema requires AR
- loadHead resolves og_media_id
- endpoints.spec: Content Creator view-only, Developer deny
- axe; seo-ci

**Risks:**

- The OG image URL must be absolute for crawlers (resolve to /_image 1200x630 on the canonical origin)

### AV-20: Settings › Integrations (typed), Forms overview, Notifications preferences

**Depends on:** AV-05, AV-08 · **Effort:** M

- Integration tiles with typed drawers: GA4 id; Search Console verification token emitted by SeoHead; Calendly URL; reCAPTCHA site key.
- Statuses are honest; no secrets in the row; read-only for non-holders.
- IntegrationsSchema becomes typed.
- Forms: a read-only overview with links to the editable copy.
- Notifications: per-user bell preferences.

**Key files:**

- src/pages/admin/integrations.astro
- packages/schemas/admin.ts
- src/components/SeoHead.astro
- src/pages/admin/forms.astro
- src/pages/admin/settings/notifications.astro

**Tests:**

- IntegrationsSchema validation (G- id, https URLs)
- SeoHead verification meta only when set
- endpoints.spec: settings.integrations
- axe

**Risks:**

- GA4 is stored but never injected (honest copy)

### AV-21: Users & roles v2: invites and a read-only role matrix

**Depends on:** AV-05 · **Effort:** L

- Users table: email joined on the server for Admin, live-rechecked.
- Edit drawer with the sign-out warning; invite drawer.
- Pending invites: list, resend, cancel (new endpoints, audited).
- Read-only role matrix from ROLE_CAPS and CAP_LABELS. The Sales column appears once CRM:sales-role lands.
- Security facts card.

**Key files:**

- src/pages/admin/users.astro
- src/components/admin/islands/AdminUsers.tsx
- src/pages/api/admin/users/index.ts
- src/pages/api/admin/users/invites.ts
- src/pages/api/admin/users/[id]/resend.ts
- src/lib/authz/capLabels.ts

**Tests:**

- endpoints.spec: invites endpoints Admin only; live-recheck on demotion (§9b)
- cancel refused for confirmed users
- matrix renders every role × capability (exhaustive)
- axe

**Risks:**

- Service-client email join (Admin only, live-recheck)
- Invite email depends on SMTP

### AV-22: Activity log v2 (server-rendered)

**Depends on:** AV-05, AV-07 · **Effort:** M

- GET filters: kind chips mapped to action-prefix sets, bounded q, 25 per page.
- Actor names from the staff directory.
- Plain-language sentences from auditLabels.ts; titles resolved under the viewer's RLS, never for leads or applications.
- Changed field names as details.
- Chain banner kept; corrected retention copy; no export.

**Key files:**

- src/pages/admin/audit.astro
- src/pages/api/admin/audit.ts
- src/lib/admin/auditLabels.ts

**Tests:**

- auditLabels covers every action key in use
- no lead or application names resolved
- audit.view gating
- axe

**Risks:**

- Title lookups per page (batched per entity type)

### AV-23: Built-in section copy as shared data (public refactor)

**Depends on:** none · **Effort:** L

- Extract each section component's STR/default copy (EN and AR) into src/lib/sections/copy/<type>.ts.
- Components import it, with byte-identical output.
- The page editor receives the defaults server-side as props, so they add no bundle weight. This is what lets fields show the current text, as the mockup does.

**Key files:**

- src/lib/sections/copy/
- src/components/sections/
- src/lib/sections/types.ts
- src/lib/services/pageCopy.ts

**Tests:**

- per-type: rendering with empty content equals the copy module
- served-html; home, about, contact, services, work and join e2e; visual capture diff

**Risks:**

- Tier A output drift, especially Arabic bytes

### AV-24: Release UX integration: savebar, review, publish, discard, autosave drafts, Backups & versions

**Depends on:** REL:drafts-api, REL:releases-api, AV-04, AV-08 · **Effort:** L

- Savebar in AdminChrome; the publisher-waiting state for SEO and Developer.
- Review drawer; Publish modal with dry-run validation; Discard.
- useEntitySave switches to debounced draft autosave with base_version and the 409 UI.
- 'Unpublished changes' badges in lists.
- Bell items for releases and changes waiting.
- Dashboard publish widget.
- /admin/backups: release timeline with preview and roll back; content export button with its 429 handling; DR facts.

**Key files:**

- src/lib/admin/release.ts
- src/components/admin/screens/chrome/Savebar.tsx
- src/components/admin/screens/chrome/PublishModal.tsx
- src/lib/admin/useEntitySave.ts
- src/pages/admin/backups.astro

**Tests:**

- e2e: the savebar never obscures focus (2.4.11); savebar per role
- publish happy path and conflict; discard scope
- axe on the savebar, review and publish dialogs

**Risks:**

- Contract churn with REL (one client module)
- Autosave and request volume (debounce, flush on blur)

### AV-25: Pages list and the page editor core

**Depends on:** AV-24, AV-23, AV-19 · **Effort:** XL

- Pages cards: section counts, badges, template cards.
- 3-column flush editor:
  - bar with the language segmented control, Visibility (AV-13), SEO drawer, History drawer (version list, restore as draft), Open, Publish, SaveStatus, 'Arabic missing: N';
  - sections list: Sortable, eye, label rename dialog, Add section modal with allowed types, delete for Admin or hide for Content Creator;
  - fields column: typed fields prefilled with built-in copy, accent ranges, variant selects, collection rows, route-data notes, join items list.
- Responsive collapse; ⌘S.
- May split into list+layout and fields+drawers.

**Key files:**

- src/pages/admin/pages/index.astro
- src/pages/admin/pages/[id].astro
- src/components/admin/islands/AdminPageEditor.tsx
- src/components/admin/screens/page-editor/
- src/lib/admin/sectionUi.ts
- src/lib/admin/pageSectionLibrary.ts

**Migrations:**

- 00NN_page_sections_label.sql: page_sections.label text null CHECK length ≤ 60

**Tests:**

- e2e: keyboard section reorder; eye; add, rename, delete per role
- sectionUi.spec: allowed types per page
- axe in the editor with each drawer open

**Risks:**

- Biggest UI slice (split if needed)
- Delete vs hide per role
- Defaults vs overrides confusion (Reset to built-in, stale-translation note)

### AV-26: Live preview iframe and the postMessage bridge

**Depends on:** REL:preview-route, AV-25 · **Effort:** M

- Preview column: device segmented control with CSSOM scale; language swaps the src; reload on draft save; jump and highlight; click to select.
- Bridge halves:
  - admin: src/lib/admin/client/previewBridge.ts;
  - preview: src/lib/preview/bridge.ts, plus preview.css, loaded only by the preview route.
  - Shared Zod envelope in packages/schemas/previewBridge.ts, an explicit targetOrigin and origin+source checks.
- buildCsp option adds frame-src 'self' on /admin/** only.

**Key files:**

- src/lib/admin/client/previewBridge.ts
- src/lib/preview/bridge.ts
- packages/schemas/previewBridge.ts
- public/styles/preview.css
- src/lib/http/securityHeaders.ts
- src/middleware.ts

**Tests:**

- bridge unit: wrong origin or source ignored; malformed envelope ignored
- securityHeaders.spec: frame-src 'self' on admin only; public unchanged
- csp.e2e: editor with preview has zero violations
- the preview route emits no analytics beacon (REL contract test)

**Risks:**

- A CSP policy change at the one enforcement point (reviewed)
- Preview fidelity depends on REL's renderer

### AV-27: Theme v1: structured colours, theme.css delivery, contrast gate, admin wears the theme

**Depends on:** AV-24, AV-26 · **Effort:** L

- ThemeSettingsSchema, compiled on the server to enum-keyed tokens with derived glow and shadow.
- packages/theme: palette generation, the contrast gate with suggestions, pairs.json shared with contrast-audit.
- custom_themes.settings and an anon read of the active row.
- /styles/theme.css?v= (immutable), linked by BaseLayout and AdminLayout only when non-default.
- site:chrome ALWAYS tag.
- Editor: Simple and Advanced, swatches, generated palette, read-only typography and motion facts, Reset.
- Live preview: CSSOM on the admin and a tokens op to the iframe.

**Key files:**

- packages/schemas/theme.ts
- packages/theme/gate.ts
- packages/theme/pairs.json
- src/lib/admin/themeCompile.ts
- src/pages/styles/theme.css.ts
- src/layouts/BaseLayout.astro
- src/layouts/AdminLayout.astro
- src/lib/http/cacheTags.ts
- src/components/admin/islands/AdminTheme.tsx
- scripts/contrast-audit.mjs

**Migrations:**

- 00NN_theme_settings.sql: custom_themes.settings jsonb; anon select policy + column grant (tokens, version) on the active row

**Tests:**

- gate property tests (accepted ⇒ every public and admin pair passes)
- ThemeTokensSchema enum keys; theme.css cannot emit ; { } < >
- BaseLayout link only when customised; cacheTags.spec
- lhci themed run; axe on themed output; contrast-audit THEME_PAIRS

**Risks:**

- An extra render-blocking request when themed (≈0.5 KB, versioned, immutable)
- Purge depends on REL and on a zone

### AV-28: Header editor and the site_chrome singleton

**Depends on:** AV-24, AV-26 · **Effort:** L

- site_chrome singleton: anon read, Admin and Developer write, version.
- getSiteChrome() with defaults equal to today.
- SiteHeader bounded variants: logo size S/M/L presets, menu alignment, hide on scroll.
- Header editor:
  - menu items card (nav.edit): Sortable, single key star, eye, Add drawer with the page picker, delete for Admin or hide for Content Creator;
  - layout and behaviour card (theme.edit) with read-only facts;
  - preview via the iframe and its scroll op.

**Key files:**

- supabase/migrations/00NN_site_chrome.sql
- packages/schemas/chrome.ts
- src/lib/data/chrome.ts
- src/components/SiteHeader.astro
- public/styles/global.css
- src/components/admin/islands/AdminHeader.tsx

**Migrations:**

- 00NN_site_chrome.sql: site_chrome singleton (header/footer/intro jsonb, version; RLS anon read, admin+developer write)

**Tests:**

- header-footer.e2e for each variant
- layout-shift with logo presets; lhci
- pgTAP site_chrome; chrome schema bounds
- axe; served-html

**Risks:**

- Header box and LCP/CLS (bounded presets and gates)
- is_key uniqueness when moving the star

### AV-29: Footer editor: columns, copyright template, light/dark, locked legal links

**Depends on:** AV-28 · **Effort:** M

- Navigation heading rows: href nullable for footer headings; at most 4 columns.
- site_chrome.footer: style, showEmail, showSocial, bilingual copyright template using {year} {brand} {place}.
- SiteFooter renders columns, socials (visible) and the dark variant.
- Legal links locked.
- Contrast-audit entries for the dark footer.
- Preview via the iframe scrolled to the bottom.

**Key files:**

- supabase/migrations/00NN_navigation_headings.sql
- src/components/SiteFooter.astro
- public/styles/global.css
- src/components/admin/islands/AdminFooter.tsx
- scripts/contrast-audit.mjs

**Migrations:**

- 00NN_navigation_headings.sql: navigation.is_heading + href nullable CHECK (footer only)

**Tests:**

- header-footer.e2e for columns and the dark style
- served-html brand gate (the template resolves the brand)
- contrast-audit dark footer; axe

**Risks:**

- The PDPL legal links must stay present (asserted)

### AV-30: Loading screen editor and the intro buckets

**Depends on:** AV-28 · **Effort:** M

- On/off writes the home hero section's intro as a typed switch (pages.write).
- Style and timing in site_chrome.intro (theme.edit):
  - styles logo-over-video, logo-on-black, none;
  - hold 500–1500 step 100; fade 300–600 step 50.
- Hero.astro emits data-hold and data-fade buckets and .intro--opaque; global.css bucket rules.
- Preview replays through a preview-only ?intro=replay.
- docs/hero-intro.md updated.

**Key files:**

- src/components/sections/Hero.astro
- public/styles/global.css
- src/lib/sections/types.ts
- src/lib/admin/sectionUi.ts
- src/components/admin/islands/AdminLoading.tsx
- docs/hero-intro.md

**Tests:**

- hero-intro.e2e: default pin kept, a bucket ordering test, opaque variant keeps pointer-events none, reduced-motion skip
- lhci / and /ar (LCP stays the logo at opacity .01)

**Risks:**

- Timing regressions (derived tokens only)
- Consent click under an opaque plate

### AV-31: Template editors for the service and project pages

**Depends on:** AV-25, AV-26, AV-14, AV-15 · **Effort:** M

- /admin/pages/template/service|project with a 'Showing [item]' picker.
- Fixed template parts as the sections list.
- 'This service/project' field groups write the entity drafts.
- 'Shared text' read-only (code-owned labels) with an explanation.
- Full editor link; preview of the item's page.

**Key files:**

- src/pages/admin/pages/template/[kind].astro
- src/components/admin/screens/page-editor/TemplateMode.tsx

**Tests:**

- e2e: switch item, edit, preview updates
- axe

**Risks:**

- Two editors for the same rows (shared useEntitySave keeps one save path)

### AV-32: Theme v2 (later): shapes and type tokens

**Depends on:** AV-27 · **Effort:** L

- Tokenise the public radii, button radius (pill/rounded/square), heading weight (700/800 — Archivo has no 900) and heading case in global.css and the route sheets, with visual regression.
- Add the Shapes and Typography cards.

**Key files:**

- public/styles/global.css
- public/styles/about.css
- public/styles/work.css
- packages/schemas/theme.ts

**Tests:**

- visual regression over page_sections × EN/AR
- contrast and axe on themed shapes; lhci

**Risks:**

- Wide public CSS churn

### AV-33: Custom pages (later): New page, a text block section, a [slug] route

**Depends on:** AV-25 · **Effort:** L

- New page dialog: EN and AR title plus slug.
- A textBlock section type: heading, accent, prose body. Touches SECTION_TYPES, schema, renderer, registry and SECTION_UI.
- Tier A [slug] and /ar/[slug] routes with SeoHead, JSON-LD, sitemap, llms, hreflang and cache tags.

**Key files:**

- packages/schemas/sectionTypes.ts
- src/lib/sections/registry.ts
- src/pages/[slug].astro
- src/pages/ar/[slug].astro

**Migrations:**

- 00NN_custom_pages.sql (if a page kind column is needed)

**Tests:**

- sections and registry parity; JSON-LD; sitemap; lhci on a sample custom page

**Risks:**

- Route collision with fixed routes (reserved slugs)

### AV-34: Admin visual baselines, full axe matrix, documentation closure

**Depends on:** AV-25, AV-27, AV-28, AV-21, AV-22 · **Effort:** M

- Turn the admin capture into toHaveScreenshot baselines at 1440 and 390, with dynamic regions masked.
- Per-role axe with dialogs open across every admin route.
- Final CLAUDE.md amendments, docs/admin-v2.md and the deviations register.

**Key files:**

- tests/visual/admin.visual.e2e.ts
- tests/a11y/axe.e2e.ts
- docs/admin-v2.md
- CLAUDE.md

**Tests:**

- visual baselines stable across two runs

**Risks:**

- Flaky snapshots (fonts ready, reduced motion, fixed data)

## Proposed standard amendments

- §2 Amendment (Admin v2 look, 2026-10): the admin wears the Brain Station admin mockup's design. The tokens live in public/styles/admin.css:
- Klein/cobalt/sky primary family; a midnight #0B0D14 sidebar; a #F5F6FA ground; 14/10/8px radii.
- Archivo and Almarai, self-hosted, Almarai 800 included.
- The AA fixes: dim2 #626A7F, side labels #919295, badge text #067647/#B54708/#B42318 on solid tints, control borders #828B9E, focus #024CFF (and #22A9FF on midnight), chart series and avatar tones ≥4.5:1.
The pairs are gated by scripts/contrast-audit.mjs ADMIN_V2_PAIRS. This replaces the 2026-08-27 'light editorial' palette, whose citation in admin.css was never recorded here.
- §2 Amendment (admin bundle): new admin code is chunked as admin-ui / admin-rich (lazy Tiptap) / admin-screen-<name>; island facades are named Admin* and covered by one glob in both .size-limit.json lists. Pending owner decision: either keep ≤300 KB gz as the SUM of admin chunks, tracked per slice in docs/admin-v2.md, or redefine it as the JS graph of the heaviest admin route at ≤300 KB gz.
- §2 Cache-Tag scheme: a new ALWAYS tag `site:chrome` (active theme, header/footer/intro settings) on every Tier A page, and `faq:all` on the contact routes. `media:all` (or a purge by media_usage) must cover every route that renders media_assets, including About, Our Work, All projects and case studies.
- §3 Pillar 1 / §7 CSP: buildCsp adds `frame-src 'self'` to /admin/** responses only, so the editor can frame the staff preview route. Public responses keep today's frame-src.
The preview bridge implements the postMessage rule:
- explicit targetOrigin;
- origin and source checked;
- a Zod envelope in packages/schemas/previewBridge.ts;
- tokens as CSS custom properties only.
The bridge script and preview.css load only on the preview route.
- §3 Pillar 1: page visibility (hidden pages) is a Worker pre-cache check like maintenance. The hidden-path list rides the site:maintenance KV snapshot; page_visibility is its own table (Admin + Developer, per the Phase 3 capability-split amendment). Maintenance and page visibility are immediate, confirmed switches and never ride a release.
- §8 Media: provider 'storage' = the public Supabase Storage bucket `media`.
- Images only: JPEG, PNG, WebP, AVIF; byte-sniffed; ≤10 MB, ≤12000 px, ≤40 MP; no SVG, GIF or animated WebP.
- Object key <tenant>/<uuid>.<ext>, written only by the service role through POST /api/admin/media/upload, with bilingual alt required.
- Delivered through the image service (`/_image`, cloudflare-binding) with image.remotePatterns pinned to the bucket path.
- Replace = a new object; a daily orphan sweep. Video stays EXC-009 until KAN-20.
- §8 Data model additions:
- admin_user_prefs (self-only RLS); faq_items; site_chrome (anon-readable singleton, Admin + Developer write; split it if theme.edit and settings.general ever diverge); page_visibility.
- page_sections.label; site_profile tagline, phone_display, map_url, favicon_media_id, app_icon_media_id; navigation heading rows; entity_seo.og_media_id; custom_themes.settings; rollup_daily_vitals.
- The definer functions staff_directory, update_my_profile and admin_environment.
- The contact FAQ moves from code to faq_items behind ONE loader feeding FaqAccordion and the FAQPage JSON-LD.
- §8 Theme:
- Structured theme settings are compiled server-side into enum-keyed CSS custom properties and served same-origin as /styles/theme.css?v=<version> (immutable).
- BaseLayout and AdminLayout link it only when a non-default theme is active.
- A contrast gate on save covers the public and admin pairs (packages/theme/pairs.json, shared with the CI audit).
- Not offered: custom CSS, third-party or uploaded fonts, smooth-scroll and parallax toggles.
- §8 File/layout conventions (admin):
- Astro server primitives in src/components/admin/ui (zero JS: shell, page heads, cards, tables, charts with table alternatives).
- React only for stateful screens: entries src/components/admin/islands/Admin*.tsx, private code in src/components/admin/screens/<name>/, shared kit in src/components/admin/kit/.
- Vanilla enhancers in src/lib/admin/client/, wired by data-enhance from AdminLayout's single script.
- No <script> in src/pages/admin/**; no React style props in admin components.
- One stylesheet, public/styles/admin.css, plus the icon sprite public/styles/admin-icons.svg.
- admin.css @font-face blocks mirror global.css. All enforced by tests.
- §6: a customised theme adds one same-origin render-blocking stylesheet (under 1 KB, versioned, immutable). lhci runs a themed configuration of the gated routes.
- §4 DoD #4 / §9: admin routes join the axe and CSP e2e suites for every role, through CI-only staff fixtures (tests/e2e/fixtures/staff.ts). The CSP inline-style assertion reads the server HTML, because CSSOM writes after hydration legitimately add style attributes.
- §10 Notifications: the in-admin bell is a derived, cap-filtered feed (no event table). Lead and application items go only to holders of their caps. No email or WhatsApp is sent.
- §5 / architecture §3.4 / §9.3: the Sales column, the new CRM caps and the app_role value are added by the CRM program. The admin's role matrix screen renders ROLE_CAPS read-only; editable role permissions, per-user grants and 'View as' are not supported.
- Docs:
- new docs/admin-v2.md (decisions AD-1…, bundle ledger, deviations register, planned IA for later modules);
- docs/hero-intro.md (intro timing buckets driven by site_chrome);
- docs/fonts.md (the admin mirrors the faces);
- architecture.md §4.3 (the bridge as implemented);
- the runbook (media bucket, SMTP for invites and resets, CI staff fixtures never in seeds).

## Owner items

- Approve the deviations register: Custom CSS, Google/custom fonts, 'View as', editable roles and per-user grants, page password and link-only, uniques/realtime/sources/audience stats, API keys and webhooks, backup restore and import, audit-log export, 'Reset demo data', CMS-editable logos, loading-screen tagline and progress bar, header CTA/tint/blur/full-screen mobile menu, footer legal-link toggles.
- Provision the public Supabase Storage bucket `media` on staging and production, confirm the current free-tier storage and egress limits (the storage meter shows the quota), and accept the public-bucket model: unpublished images are reachable only by unguessable URLs.
- Configure an SMTP provider for Supabase Auth (invites and password reset) with SPF/DKIM on the sender domain. Without it, Forgot password and Invite cannot deliver.
- Create the Cloudflare zone that the release backend's purge-by-tag and the WAF rules need (/api/admin/search, /api/admin/auth/forgot).
- Decide the admin bundle budget early. Projected end state is about 271–281 KB gz before the CRM screens. Options: keep 300 as a sum and take the Tiptap-diet lever; redefine it as the heaviest admin route; or amend the number.
- Confirm 'Keep me signed in' defaults to checked (today's 7-day behaviour); unchecked would give session-only cookies.
- Confirm the logo stays a code asset (it is the home LCP element). Making it CMS-editable is a later slice with an LCP re-gate.
- Name who owns the FAQ content once it moves to the CMS. It is seeded from today's CONTACT_FAQ.
- Approve, or defer, the later slices: Theme v2 shapes and type (a public CSS refactor with visual regression) and Custom pages (New page + text block + [slug] route).
- Agree that Content Creator keeps the home intro on/off switch (pages.write), while intro style and timing move to theme.edit (Admin + Developer).

## Open questions

- REL: which entities are draftable vs immediate? This design assumes:
- immediate: maintenance, page visibility, users, integrations, the redirects table, accepting_applications, site_settings, media uploads and deletes;
- staged: media alt, tags and replace; site_profile; entity_seo; navigation; theme; site_chrome.
Is that right?
- REL: is selective publish (a subset of pending changes) supported? What is Discard's scope (mine vs everything)? Do SEO's and Developer's staged changes simply wait for an Admin or Content Creator, as the savebar's 'waiting for a publisher' state assumes?
- REL: what are the drafts API shape (base_version, 409 body) and the overwrite rule on draft conflicts? Is there a composite draft for save_portfolio (row + services + media)? Does a slug change stage its 301 in the same release?
- REL: preview route URL and params (path, locale, version for past releases). Will it guarantee these?
- `data-preview-section` wrappers;
- noindex;
- no RUM or analytics beacon;
- no consent banner;
- the bridge script and preview.css included;
- a preview-only `?intro=replay`.
- REL: will media_usage include draft references (so deleting media used only in a draft is refused)? Will list APIs carry a per-entity pending flag for the 'Unpublished changes' badges?
- REL vs this design: who owns the per-entity history list and 'restore as draft' API (content_versions)? Is the History drawer fed by releases, by content_versions, or by both?
- CRM: what are the Sales cap names? Does Sales hold analytics.read (Website stats)? Does Developer keep leads.manage after the CRM core? Which queries feed the nav counts (new leads, my overdue tasks) and the dashboard pipeline/tasks widgets? Which lead events should ring the bell beyond 'new lead' (e.g. assigned to me)?
- CRM: who adds the service_of_interest filter to the leads list API for the service editor's Leads tab? This design adds only the counts aggregate.
- Stats: how long are rollup_daily_pageviews rows retained? Previous-period deltas on the 90-day range need 180 days of rollups.
- Site health: is the score formula (field vitals 50% + checklist 50%, no uptime) acceptable until the external monitor is integrated?
- Should the editor's language control ship the third 'Both' (side-by-side) option for translators, or only the mockup's English | العربية?
- Accent control UX: two word selects plus a live preview (as designed), or click-a-word chips? Both write the same AccentSchema range.
- Should page_sections keep the legacy aboutStory, team and certifications types in the Add section library, or hide them?

## Deviations from the prototype

- Site-wide hash router → real /admin/** server routes (Tier C, per-page server authz, §2). Retired repo routes 302 to their new homes.
- 7 roles, editable role permissions, per-user grant/deny and 'View as' → the 4 locked roles plus Sales from the CRM program, with a read-only role matrix generated from ROLE_CAPS (§5; RLS cannot express per-person overrides).
- Global savebar with fake site versions → the release backend's real drafts and releases. Maintenance and page visibility stay immediate, confirmed switches (Pillar-1 kill switches enforced before the cache; Developer holds them but cannot publish).
- Discard wipes the whole demo database → Discard reverts only pending changes, within the release backend's scope, after a danger confirm.
- Error and warning toasts → toasts are success/info only; errors stay inline and persistent, warnings become inline notes or disabled-with-reason states (WCAG; repo toast policy).
- Contenteditable rich fields storing <b>/<em>/<a> HTML and the 'Aa' highlight button → typed fields, AccentSchema word-range controls, and Tiptap (sanitised JSON) only where a body was already rich (Pillar 1).
- Section library of 12 generic blocks including Custom HTML, Gallery, Video and Text block → only the typed section types allowed on each page. Custom HTML is never built; Text block arrives with the later Custom pages slice.
- Per-section settings (background, spacing, reveal, show on mobile, editable anchor) → not offered. Existing per-type layout variants are shown; anchors are code-owned and read-only (CSP removed style; visual-regression and contrast scope; content parity for mobile).
- Page visibility 'Only people with the link' and 'Behind a password', plus hide-from/until dates → only Visible / Hidden (404 or to the homepage), immediate. Password pages cannot be edge-cached and would need hashing and rate limits.
- '+ New page' → hidden until the later Custom pages slice (no dynamic public route or generic section type exists today).
- Template pages' 'Shared text' editable → read-only in v1, because those labels are code (SERVICE_PAGE_COPY, case-study components).
- Service explanation as a plain textarea → kept as Tiptap rich text (services.body). Value cards max 4 → repo max 6 with a 'Three cards work best' hint. Problems max 5 → repo max 6.
- Case-study 'Client' free pick → read-only from the linked project (the repo derives it).
- Project keywords copied EN→AR → bilingual keywords; Arabic is first-class (Pillar 3).
- Inline project testimonial (quote/who/role) → a linked testimonials row with a consent record (testimonials consent gate; sample lock).
- Projects' free 'Service tags' taxonomy → projects link to the 28 real services; the tags drawer links to Services instead of creating tags.
- Clients' Visible as a casual eye → the fail-closed public-disclosure switch, with an explanation.
- Delete actions for every content role → Archive/delete is Admin only; Content Creator gets Hide (content.archiveDelete).
- Media library: single-language alt, MP4 uploads up to 200 MB, SVG uploads, local blob previews → bilingual alt required at upload; images only (JPEG/PNG/WebP/AVIF, ≤10 MB, byte-sniffed); video stays self-hosted (EXC-009); no local previews (img-src has no data:/blob:).
- Dashboard: Unique visitors, Realtime, Won-this-quarter with a fake delta, Leads×20 on the visits chart, Team notes → page views from rollups; leads on their own chart for lead roles only; Realtime and Team notes omitted; won/pipeline arrive with the CRM.
- Dashboard and palette expose lead names and budgets to every role → lead widgets and items only for lead-holding roles, safe columns only, never budget. Leads, contacts and applications are never indexed in ⌘K.
- Website stats: Sources, Audience, Conversions, Realtime and Goals tabs → v1 has Overview, Pages and Search only (no ingest enrichment; PDPL decisions pending). 'No cookie banner needed' copy corrected.
- Site health: uptime, incidents, response time, Lighthouse scores, broken links, Search Console, SSL expiry and alerts → v1 shows field vitals per path, errors, a checklist from real data and security facts. The score formula is labelled.
- Theme: Custom CSS, Google/Adobe/uploaded fonts, smooth scrolling, parallax and the reduce-motion toggle → not offered. Fonts are a closed self-hosted catalogue; reduced motion is respected automatically. Corner radius and button style wait for the Theme v2 slice.
- Header: CTA button, logo position, transparency/tint/blur, 'stays as it is' after the hero, hide-language-switch and full-screen mobile menu → bounded options only: logo size S/M/L, menu alignment, hide on scroll. The language switch always shows; the zero-JS menu is kept.
- Footer: switching off Privacy/Terms → the legal links (incl. Cookie policy) are always shown (PDPL). Free-text copyright → a template with {year} {brand} {place} (brand is data, §1).
- Loading screen: duration up to 3000 ms with a warning toast, progress-bar style, tagline, 'remembered per browser' → hold 500–1500 ms enforced by the schema, fade 300–600 ms, logo-over-video / logo-on-black / none, once per tab.
- General: editable domain, default language, languages on/off and timezone → read-only facts (PUBLIC_SITE_URL; both language twins always built). Logos stay code assets (home LCP). Maintenance copy, auto-off date and staff bypass come later.
- SEO: sitemap and structured-data on/off, a single canonical URL, EN-only Google preview → read-only status rows, per-language canonicals and EN + AR (RTL) previews. Redirects get status codes and a table instead of a drag repeater. 'Check for broken links' comes later.
- Forms editor (labels, required, add fields, budget ranges, honeypot/reCAPTCHA/consent toggles) → a read-only overview in v1. The field sets are closed Zod contracts; the honeypot is always on; recruitment consent is versioned.
- Notifications settings (email, WhatsApp, auto-reply, Slack, assignment) → in-admin bell preferences only. No outbound sending (A1).
- Integrations (Resend, WhatsApp, Sheets, Slack, HubSpot, webhooks, API key, fake 'Test connection') → typed GA4 / Search Console / Calendly / reCAPTCHA forms with honest 'Set up' statuses and no secrets in the row. The others come later; API keys are declined.
- Activity log 'Kept for 90 days' and CSV export → kept permanently and tamper-evident; no export (export lockdown).
- Backups: 'covers everything including leads', backup restore and JSON import → a content-only export button, release history with roll back, and a DR explanation. No restore or import buttons.
- Account: Edit profile/2FA/Admin language placeholders → working profile and password; 2FA hidden until MFA exists; language shown as English.
- Login demo role chips, prefilled credentials and base64 logo → removed. The logo is a same-origin image; Forgot password and Keep me signed in are real.
- Sidebar hidden below 900px with no replacement → a zero-JS popover navigation drawer (WCAG 1.4.10).
- Whole-row click handlers, click-only divs, drag-only reorder, hover-only actions → links in title cells, real buttons, keyboard and up/down reordering, actions on focus-within (WCAG 2.1.1, 2.5.7).
- Mockup palette values failing AA (dim2, sidebar labels, badge ok/warn/err text, input borders, toggle track, sky/amber/green chart strokes, three avatar colours) → the contrast-fixed tokens in the design.
- Google Fonts link → self-hosted Archivo/Almarai (font-src 'self').
- Sidebar items the mockup lacks are added: Creative Knowledge, FAQ (a new table), Numbers, Certifications, Style-Finder, Job applications (Admin-only Hiring group). Nav labels follow the client's wording: Projects, Team, Website stats, Activity log, Media library, Users & roles.
