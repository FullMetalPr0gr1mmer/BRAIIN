# Hero intro choreography

The home hero (`/` and `/ar`) opens with the brand logo on a full-viewport plate, which
then hands off to the headline, the sub-line and the CTA in a strict order. This file is
the record of how that works, why it is built the way it is, and how to change or revert
it safely.

**Restore point:** `hero-intro-baseline-2026-08-24` (tag, = `d145aee`) — the last state
verified working in production. See [Rolling back](#rolling-back).

---

## 1. The one thing to know before editing

**Every instant in the choreography is DERIVED from two numbers.** Change those two and
everything downstream moves with them, in both locales. Do not reintroduce a literal
anywhere — that is the exact defect this design replaced.

```css
/* public/styles/global.css — :root */
--bs-intro-hold: 3.5s;   /* the logo holds the plate, alone */
--bs-intro-fade: 0.4s;   /* the plate + logo leave together */
```

Everything else composes from them, declared on `body` (not `:root` — see §5):

```css
--bs-intro-wait: calc(hold + fade)                 /* the instant the plate is GONE */
--bs-hero-lead:  calc(word-step * 9 + letter-step * 13)   /* last letter's offset */
--bs-hero-in:    calc(intro-wait + hero-lead)      /* headline fully arrived */
```

| Element | Delay | With the shipped 3.5s / 0.4s |
| --- | --- | --- |
| `.intro` plate | `hold`, then `fade` | fades 3.500s, gone at **3.900s** |
| `.letter` | `intro-wait + wd + ld` | starts **3.900s** |
| `.hero__sub` | `hero-in + beat` | **4.611s** |
| `.hero__cta` | `hero-in + beat * 2` | **4.761s** |
| `.hero__scroll`, `.site-header--overlay` | `hero-in + beat * 3` | **4.911s** |
| settled | | **5.611s** |

`--bs-hero-in` is **4.461s** here (`3.9 + 0.561`).

`--bs-hero-beat` is `0.15s`. `--bs-hero-word-step` / `--bs-hero-letter-step` drive the
per-word / per-letter stagger and are overridden once for `html[dir='rtl']` (Arabic
splits per word, because splitting Arabic glyphs breaks their joining forms).

### To retime the intro

Change `--bs-intro-hold` and/or `--bs-intro-fade`. Nothing else. Then update the seek
times in `tests/e2e/hero-intro.e2e.ts` (§4) and re-run it.

---

## 2. Why the overlay is transparent, and what now protects the headline

`.intro` is **transparent**: the hero loop plays underneath the logo from the first
frame, matching the Brain Station UI reference (`/* 0. INTRO — logo over the clean
video, no overlay behind it */`). The logo also carries **no drop-shadow** — a deliberate
choice; the reference keeps `drop-shadow(0 6px 40px rgba(0,0,0,.45))`, and that is the
one-line fix if the wordmark ever washes out against a lighter cut of the loop.

**This is only safe because the headline is TIME-gated.** Every entrance holds
`opacity: 0` under `fill: both` until `--bs-intro-wait`, so while the logo is up there is
nothing on screen to collide with. Read that before touching any entrance delay.

It was not always so. The overlay was originally transparent **while the headline
animated in at t≈0.15s**, which composited a white wordmark straight onto white headline
text. Whether that read as "layered" or as a collision was decided purely by viewport
geometry — the logo is fixed and centred, a constant 520×266 above 1131px of width, while
the headline is bottom-anchored and grows *upward* as it wraps:

| Viewport | Result on the original build |
| --- | --- |
| 2560×1440 | 262px clear |
| 1920×1080 | 92px clear |
| 1728×900 | clear (headline fits on 2 lines) |
| **1690×900** | **collides — the wrap cliff** |
| **1680×900** | **collides, 77px (worst)** |
| **1512×945** | **collides, 60px** |
| **1366×768** | **collides, 122px** |
| 412×823 | clear |

Note the shape: between 1366 and 1680 the overlap gets **worse** as the screen gets
wider, then vanishes in one step at ~1700px. "It looks fine on a bigger monitor" was a
true observation about a real cliff, not a misreport.

An intermediate version made the plate **opaque** (painted with `--bs-hero-backdrop`),
which made the collision *structurally* impossible — no timing assumption required. That
was traded away to get the video visible under the logo. The protection is now purely
temporal, which means:

> **If anyone un-gates `.letter` from `--bs-intro-wait`, the collision returns in full,
> and only on screens under ~1700px wide.** `tests/e2e/hero-intro.e2e.ts` is what stands
> between that edit and a shipped regression. Do not delete it.

---

## 3. Why the plate waits for the logo

The plate is a stopwatch. The logo is a **runtime Cloudflare image transform**, and its
latency is not a constant. Measured on production, three consecutive cold loads:

```
3583ms   (cold edge)
 742ms   (warm)
 747ms   (warm)
```

With a fixed 1.8s plate, the cold case lifted before the logo existed — a blank backdrop
followed by the headline, logo never seen. The previous 4.2s timeline had only ever
hidden this **by accident**, by happening to outlast the cold fetch; nothing recorded
that the two numbers were related.

So `Hero.astro` adds `body.intro-waiting`, which sets `animation-play-state: paused` on
the plate and every entrance until the logo has actually painted. Pausing rather than
retiming is deliberate: mutating a delay mid-flight remaps local time onto progress
(CSS Animations L1 §4), whereas a paused animation holds in place and resumes exactly
where it stopped. This is the same reason the skip path uses `animation: none`.

Three failure modes, all closed — an opaque, full-viewport, pointer-capturing plate that
never lifts would be far worse than the bug it fixed:

| Case | Behaviour |
| --- | --- |
| JS off | class never added, pure-CSS timeline runs as before |
| Logo slow | `HOLD_CAP_MS = 2000` releases anyway |
| Logo broken | releases **immediately** |

That last one is subtle. The check is `logo.complete`, **not**
`complete && naturalWidth > 0`: an image that already errored before this deferred module
ran is `complete` with `naturalWidth === 0`, and waiting on an `error` event that has
already fired would stall on the cap for nothing. Settled is settled, either way.

---

## 4. Tests

`tests/e2e/hero-intro.e2e.ts` — 30 tests, runs under `npm run test:e2e`, and is picked
up by the `a11y` job in `.github/workflows/perf-seo-a11y.yml`.

It seeks with the **Web Animations API** (`getAnimations()` → `pause()` →
`currentTime = T`), not screenshots. `currentTime` includes `animation-delay`, so seeking
every animation to the same `T` is exactly "T ms into the choreography" and is
deterministic on any CPU. Screenshots flake on a 3.5s sequence, and
`toHaveScreenshot({animations:'disabled'})` fast-forwards `fill: both` entrances to their
**end** state — it renders the post-intro frame and tells you nothing about ordering.

Two skip rules in `seek()`: scroll/view-timeline animations are progress-based and throw
on an absolute `currentTime`, and infinite animations have no meaningful position.

**If you retime the intro, these need updating** — they carry absolute instants:

- `strict order: logo alone, then headline, then sub, then button` — seeks 2000 / 4100 /
  4700 / 5200 / 6500.
- `the logo never shares the screen with the headline` — seeks 200…3850.
- `a cold/slow logo holds the plate…` — its injected `/_image` delay must stay comfortably
  ABOVE `--bs-intro-wait`, or the plate would be up at the sample point regardless and the
  test proves nothing.

> **Never** `click()`, `press()`, `mouse.wheel()` or scroll before an ordering assertion.
> `wheel|touchstart|keydown|pointerdown|focusin` all cut the intro, and the CSS hides the
> plate on `html:has(:focus-visible)`. Use `boundingBox()` and `evaluate()` only.

---

## 5. Traps that have already bitten, once each

**Custom properties holding `calc()` do not resolve on `:root`.** Substitution happens at
computed-value time on the *declaring* element, so `--bs-intro-wait` on `:root` resolves
against `:root`'s own `0s` inputs and `body` inherits the already-substituted
`calc(0s + 0s)`. The derived tokens are declared on `body`, where the state classes live.
This also means `getComputedStyle(...).getPropertyValue('--bs-hero-in')` returns a token
stream, not a time — the test recomputes from the leaf tokens instead.

**Never put `opacity: 0` on `.hero h1` or `.word`.** The entrance from-state lives on the
inline `.letter` spans *only*. A block-level opacity animation makes Chromium record **no
LCP candidate at all** — permanently, even after the fade completes — which fails both
`categories:performance` and `largest-contentful-paint` in `lighthouserc.json`. The old
code carried a comment claiming the *gate* blew the LCP budget; that was measurably false
(1966ms ungated vs 1968ms gated) and this cliff is almost certainly what was actually hit.

**The LCP element on home is the intro logo `<img>`**, not the headline and not the
poster (a CSS `background` is not an `<img>`, and the blur poster is far too low-entropy
to qualify). Chromium aggregates text LCP at the block ancestor, so the `<h1>` registers
at first paint while every `.letter` is still transparent.

**Reduced motion reveals entrances by killing their animation.** That only works because
the hidden from-state lives exclusively inside `@keyframes`. Adding a static `opacity: 0`
to any entrance selector without also pinning it in the reduced-motion block ships a
permanently blank `<h1>` to those users — and axe has no rule for "visible text at
opacity 0", so nothing in CI would catch it.

**The stagger ladder is finite.** 10 word rungs × 14 letter rungs. `HeroSectionContentSchema`
bounds CMS headlines to exactly that, which is what keeps `--bs-hero-lead` a real upper
bound. Past the last rung the stagger flattens into a simultaneous pop.

---

## 6. Related decisions

- **EXC-007** (`docs/security-exceptions.md`) — the motion pause control was removed from
  the hero for parity with the Brain Station UI reference. That is a **WCAG 2.2.2
  (Level A)** regression covering the hero loop, the slogan-band loop and the clients
  marquee together. The *mechanism* (`setMotionPaused()`, `body.motion-paused`) is
  deliberately retained with no caller so restoring it is a button plus one listener.
  **No CI gate detects this** — axe cannot decide it and Lighthouse a11y stays at 100.
- **`withHomeIntro()`** (`src/lib/sections/types.ts`) — the plate is opted into at the
  **route** level, not baked into CMS content, so authoring the home page in the CMS
  cannot silently drop it and a `hero` section on any other page can never inherit an
  undismissable overlay. An explicit `intro` in CMS content still wins; that is the off
  switch.

---

## Rolling back

The last verified-good state is tagged **`hero-intro-baseline-2026-08-24`** (`d145aee`).

Preferred — revert the bad change, keep history:

```bash
git revert <bad-sha>
git push origin main          # CI re-runs and redeploys
```

Just the hero files, if a later change went wrong but you want to keep everything else:

```bash
git checkout hero-intro-baseline-2026-08-24 -- \
  public/styles/global.css src/components/sections/Hero.astro
npm run format && npm run test && npm run build
```

See exactly what changed since the baseline:

```bash
git diff hero-intro-baseline-2026-08-24 -- \
  public/styles/global.css src/components/sections/Hero.astro
```

**Verifying a rollback took, in production** — the deploy is `ci.yml`'s `deploy` job on
push to `main`, and it *skips* (green) if the Cloudflare secrets are missing, so a green
run is not proof of a deploy:

```bash
gh run list --branch main --limit 4 --json databaseId,name,conclusion   # pick the CI run, not DB tests
gh run view <id> --json jobs --jq '.jobs[] | select(.name=="deploy") | .steps[] | "\(.conclusion)\t\(.name)"'
curl -s https://braiin-station.braiin.workers.dev/styles/global.css | grep -A6 '^\.intro {'
```
