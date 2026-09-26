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
