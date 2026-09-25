# Security Exceptions Register

Documented, time-boxed exceptions to the engineering standard, per **CLAUDE.md §11** ("flag and propose … a documented exception with an owner and expiry"). The pillar order **Security > Performance > SEO > Scalability** is never _silently_ weakened — every deviation is recorded here with an owner, a justification, and an expiry, and is revisited on or before that date.

Every entry carries a **close condition** as well as an expiry. An expiry alone rots: EXC-001 sat open for six weeks after the thing blocking it (a Node 20 baseline) had already been removed by unrelated work, because nothing stated what to watch for. State the condition concretely enough that someone doing adjacent work trips over it.

| ID      | Opened     | Owner                          | Expiry     | Status | Summary                                                                                     |
| ------- | ---------- | ------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------------------- |
| EXC-001 | 2026-06-14 | Developer (tech@purecoffee.sa) | 2026-09-12 | **Closed 2026-08-01** | `npm audit` high+ gate was advisory. Tree is now 0 high / 0 critical; gate is blocking in both scopes |
| EXC-002 | 2026-08-01 | Developer (tech@purecoffee.sa) | 2026-08-15 | **Closed 2026-08-01** | Migration `0011` (schema `app` grants) shipped ahead of its pgTAP suite — suite now green in CI |
| EXC-003 | 2026-08-01 | Developer (tech@purecoffee.sa) | 2026-08-15 | **Closed 2026-08-01** | Migration `0012` (audit-chain `hmac`) shipped ahead of its regression test — test now green in CI |
| EXC-004 | 2026-08-01 | Developer (tech@purecoffee.sa) | 2026-09-01 | Open   | Live on `*.workers.dev` with **no WAF rate limits and no crawler blocks** — both are zone-scoped and there is no zone |
| EXC-005 | 2026-08-22 | Developer (tech@purecoffee.sa) | 2026-11-30 | **Closed 2026-09-25** | `js-yaml` GHSA-5p4m-2wfm-xmqj allowlisted in the prod audit gate — js-yaml 4.3.2 shipped the 4.x fix; entry removed |
| EXC-006 | 2026-08-22 | Developer (tech@purecoffee.sa) | 2026-11-30 | Open (re-scoped 2026-09-25) | `extract-zip` GHSA-jmr9-qjv8-65gv **+ GHSA-7pqw-9j4j-h8q3** allowlisted in the dev audit gate — every published version is affected |
| EXC-007 | 2026-08-24 | Kareem (kareem@floppytech.ai)  | 2026-11-24 | Open   | Hero pause control **removed** — autoplaying hero/slogan video + clients marquee now have no pause mechanism for non-reduced-motion users (**WCAG 2.2.2, Level A**) |

---

## EXC-001 — Supply-chain `npm audit` high+ gate temporarily advisory

**Pillar:** 1 (Security) — CLAUDE.md §3 (Pillar 1) / §7; architecture §4.10.
**Opened:** 2026-06-14 · **Owner:** Developer (tech@purecoffee.sa) · **Expiry:** 2026-09-12 (90 days).

### What changed

The CI `supply-chain` job (`.github/workflows/ci.yml`) previously failed the build on `npm audit --audit-level=high`. It now runs two steps:

- **Blocking:** `npm audit --omit=dev --audit-level=critical` — production (shipped) deps, critical only.
- **Advisory (non-blocking, `continue-on-error`):** full `npm audit --audit-level=high` — still printed in the logs, does not fail the build.

### Why (justification)

`npm audit` currently reports **1 critical + 9 high** (27 total). Every high/critical is in **build / dev / test tooling that is not present in the deployed Cloudflare Worker bundle**:

- `vitest` (critical — UI-server arbitrary file read/exec): test-only devDependency.
- `esbuild`, `vite`, `@vitejs/plugin-react`: bundler / dev-server, build-time only.
- `wrangler`, `undici`, `miniflare`: CLI / local preview, dev-only.
- `tmp` (via `@lhci/cli`): Lighthouse CI, CI-only.
- `astro`, `@astrojs/cloudflare`, `@astrojs/react` are flagged **high only because they pull the above as transitive npm dependencies**; their own advisories are **moderate/low**: `astro` define:vars XSS (moderate, already mitigated by the no-`unsafe-inline` CSP), `astro` server-island replay (low), `@astrojs/cloudflare` image-binding SSRF (low).

The shipped Worker (output of `astro build`) contains none of the bundler / test / CLI packages, so residual production risk is low and is bounded by the blocking critical guard above.

### Why not fix now

The only remediation `npm audit` offers is a **breaking** upgrade to `astro@6` / `@astrojs/cloudflare@13` / `@astrojs/react@5` / `vitest@4`, which **requires Node ≥ 22.12**. The current baseline is Node 20 (CI `node-version: 20`, `engines >=20.3.0`, portable toolchain `.tools/node-v20.18.0`). That is a coordinated **Node 20→22 + Astro-6** migration affecting CI, every dev machine, the portable toolchain, and teammate onboarding — to be done deliberately, not mid-phase-1.

### Remediation plan (clears this exception)

1. Adopt Node 22 baseline (CI `node-version: 22`; `engines >=22.12`; refresh `.tools`).
2. Upgrade `astro`→6.x, `@astrojs/cloudflare`→13.x, `@astrojs/react`→latest, `vitest`→4.x, `@lhci/cli`→latest.
3. Verify `astro check` + `build` + tests on Astro 6; migrate any breaking config (adapter / env / i18n APIs).
4. Confirm `npm audit --audit-level=high` is clean, then **restore the blocking full high+ audit** (remove `continue-on-error` and the `--omit=dev` / critical split) in `ci.yml`, and close this entry.

### Revisit

On or before **2026-09-12**. If still unresolved, re-justify and set a new expiry — never extend silently.

### Re-scope 2026-08-01 — the stated blocker no longer exists

The "why not fix now" above is **out of date** and is kept for history rather than deleted. It argues the fix is blocked behind a Node 20 → 22 migration. That migration has already happened, as a side effect of the Astro 7 / adapter 14 work (see the CLAUDE.md §2 amendment):

| Claimed above                      | Actual on 2026-08-01                  |
| ---------------------------------- | ------------------------------------- |
| CI `node-version: 20`              | `node-version: 22` (both jobs)        |
| `engines >=20.3.0`                 | `engines >=22.12.0`                   |
| needs breaking upgrade to `astro@6` | already on `astro ^7.1.1`             |

Remediation steps 1–3 are therefore **done**, and the counts moved with them: **27 vulnerabilities → 15** (6 low, 5 moderate, 3 high, 1 critical), with the blocking gate `npm audit --omit=dev --audit-level=critical` reporting **0**.

**What actually remains:** `vitest` is still `^2.1.0`, and it is the one critical — the test-only UI-server advisory named above. Bump it to 4.x (plus `@lhci/cli`), re-run the full audit, and if clean, remove `continue-on-error` and the `--omit=dev`/critical split from `ci.yml` and **close this entry**.

**Close condition:** `npm audit --audit-level=high` exits 0 → restore the blocking gate → close. This is a contained dependency bump now, not a toolchain migration.

### Closed 2026-08-01

The close condition was met exactly as written. What it took:

| Step                                        | Result                                             |
| ------------------------------------------- | -------------------------------------------------- |
| `vitest` `^2.1.0` → `^4.1.10`               | clears the **critical**; no config change needed, 481 tests / 29 files still pass |
| `@lhci/cli` `^0.14.0` → `^0.15.1`           | clears one `high`                                   |
| `npm audit fix`                             | clears `brace-expansion` (non-breaking)             |
| `overrides: { "tmp": "^0.2.7" }`            | clears the last `high`                              |

**15 vulnerabilities → 2**, both moderate and both dev-only (`@lhci/cli`, `uuid`). `npm audit --audit-level=high` exits **0**; `npm run typecheck` and `npm run build` pass.

The `tmp` override needs its reasoning recorded, because npm's own advice was wrong. `tmp` reaches the tree as `@lhci/cli` → `inquirer` → `external-editor` → `tmp@0.0.33`, and `npm audit` proposed "fix available: `@lhci/cli@0.1.0`" — a **downgrade of 14 minor versions** that npm labels `isSemVerMajor`. Taking it would have traded two path-traversal advisories in CI-only tooling for a four-year-old Lighthouse CLI. Pinning the transitive dependency forward is the correct direction, and it is the reason `overrides` exists.

**Gate restored, with one deliberate change.** The blocking step is `npm run audit:all`, not the bare `npm audit --audit-level=high` this entry originally promised. Both block on the same condition; only the former can be lived with. `npm audit` resolves against a remote advisory database that changes without this repository changing, so a bare invocation can turn every unrelated PR red on a commit that touched nothing, and offers exactly two responses: fix a dependency you may not control, or re-add `|| true` under deployment pressure. The second is how the suppression this entry documents got there in the first place. Routing the dev scope through `scripts/audit-gate.mjs` adds a third response — an entry with a reason and an **expiry** — and the expiry is what stops it from becoming the same silent suppression under a different name.

---

## EXC-002 — Migration 0011 (schema `app` grants) shipped ahead of its pgTAP suite

**Pillar:** 1 (Security) — CLAUDE.md §3 / §5 / §9 (DoD point 5: "Tested — … + per-role authz").
**Opened:** 2026-08-01 · **Owner:** Developer (tech@purecoffee.sa) · **Expiry:** 2026-08-15 (14 days).

### What changed

`0011_app_schema_grants.sql` was applied to the provisioned project before its tests existed. It grants `USAGE` on schema `app`, revokes and re-grants an `EXECUTE` allowlist, revokes all table privileges from `anon` and grants back `SELECT` on 14 relations, and adds four **restrictive** SELECT policies (`navigation`, `partner_logos`, `page_sections`, `entity_seo`).

### Why (justification)

The site was **completely down**. Every anonymous read returned `42501 permission denied for schema app`, because no migration had ever granted `anon` USAGE on the schema every RLS policy depends on. Waiting for tests meant leaving production dark.

The change was not unverified — it was reviewed by three independent adversarial passes (which caught three real over-grants in the first draft, including an unpublished-content leak via `page_sections`), and validated against the live database by a 31-assertion negative probe covering anon writes, PII tables, unpublished content and privileged RPCs, all passing. But a probe run once from a scratch directory is not a regression test, and it does not run in CI.

### Remediation plan (clears this exception)

1. ✅ `supabase/tests/grants_app_schema.test.sql` — written 2026-08-01 (25 assertions: schema gate, helper allowlist, default-deny, an exhaustive catalog assertion so a future `app.*` routine cannot silently become PUBLIC-executable, table privileges, and the deny list).
2. ✅ `.github/workflows/db-tests.yml` promoted off `workflow_dispatch` — see EXC-003, same root cause.
3. ✅ Per-role rows over `{admin, content_creator, seo, developer, anon, other_tenant}` for the four restrictive policies added in 0011 §5b — `supabase/tests/rls_restrictive_0011.test.sql`, written 2026-08-01 (28 assertions).
4. ✅ Fix `rls_admin_cms.test.sql`'s `entity_seo` fixture — done 2026-08-01 in `c8110fe`, green in run `30702922011`. It now seeds a published **and** a draft service and asserts anon sees exactly the published one.

**Close condition:** items 3 and 4 merged and green in the `db-tests` workflow. → **Met. Closed 2026-08-01** — run `30704786054`: `rls_restrictive_0011.test.sql .. ok` (28/28) and `rls_admin_cms.test.sql .. ok`.

All seven non-Arabic pgTAP suites are green. The workflow itself is still red on the 5 Arabic FTS normalization cases in `search_content.test.sql` — a genuine recall gap against the CLAUDE.md §8 pass bar, tracked separately and deliberately left un-hidden. It is **not** covered by this exception and does not hold it open: this entry is about 0011's grants, and those are now proven.

### What item 3 actually covers

Six roles × four policies, plus two assertions the original scope did not ask for and should have:

- **The orphan.** 0011's comment claims a row whose parent no longer exists "fails closed". That was prose. `entity_seo` now carries a ninth fixture row pointing at a service id that does not exist, asserted invisible to `anon` and visible to staff — so the fail-closed default is a test, not a promise.
- **The modifier itself.** Recreating any of the four without `as restrictive` reopens the exact disclosure it closed — silently, and with every other assertion in the file still green, because a permissive policy ORs with the others and narrows nothing. The last assertion reads `pg_policies.permissive` for all four names.

One row deviates from the six-role template on purpose. `page_sections` is deliberately **not** in 0011's anon grant list (nothing reads it anonymously until the section renderer ships), so `anon` is denied at the GRANT layer and its row is a `throws_ok(42501)` rather than a count. That proves the outer gate but leaves the policy itself — the half that has to keep working the day the grant is added — untested. A seventh row covers it: a signed-in session with **no role claim**, which holds the `authenticated` table grant but fails `app.is_staff()`, and must see only the visible section of a published page.

**A note for whoever adds that grant:** the `throws_ok` above is the assertion that will fail. It is meant to. It is the one place where turning on anonymous reads for `page_sections` forces a decision instead of a diff.

---

## EXC-003 — Migration 0012 (audit-chain `hmac`) shipped ahead of its regression test

**Pillar:** 1 (Security) — CLAUDE.md §3 (audit chain), §9, §10.
**Opened:** 2026-08-01 · **Owner:** Developer (tech@purecoffee.sa) · **Expiry:** 2026-08-15 (14 days).

### What changed

`0012_audit_chain_hmac_schema.sql` schema-qualifies one call: `hmac(...)` → `extensions.hmac(...)` in `app.tg_audit_chain()`.

### Why (justification)

The audit chain had **never written a row**. `hmac` is a pgcrypto function; Supabase installs pgcrypto into `extensions`; the trigger's `search_path` was `public, app, vault, pg_temp`. Every insert into `audit_log` raised, and `writeAudit()` catches and returns `false` so that an audit failure cannot roll back the operation it describes. Net effect: a CMS that worked perfectly and recorded nothing, with no error in any log. The `bigserial` sequence had reached **7** with zero rows in the table — six silently lost entries.

This is a Pillar 1 control (§3: "`audit_log` append-only + HMAC-hash-chained"), so it was fixed and pushed immediately rather than held for a test.

### The deeper cause, and what was done about it

Two things made this survivable for twelve migrations:

- **The pgTAP suite has never run.** `db-tests.yml` was `on: workflow_dispatch` only, staged "until validated against the provisioned project" — zero runs, ever. **Promoted to push/PR on 2026-08-01.**
- **`writeAudit` returned `false` to nobody.** "Must not throw" and "must not be noticed" are different requirements and only the first was implemented. It now also writes to `system_logs` — a different table with a different write path (service-role, no chain trigger), chosen deliberately because the most likely reason an audit write fails is that something about `audit_log` itself is broken.

### Remediation plan (clears this exception)

1. ✅ `supabase/tests/audit_chain.test.sql` — written 2026-08-01 (11 assertions: digest well-formed, `prev_hash` links, caller-supplied `hash`/`prev_hash` overwritten by the trigger, per-tenant chains, no UPDATE, no DELETE). Asserts the **chain**, not that the API returned 200 — it returned 200 throughout the outage.
2. ✅ Verify the suite passes in CI against the local stack (no Docker on the current dev machine; unverifiable locally). **Green 2026-08-01** — run `30702922011`, `audit_chain.test.sql .. ok`, 11/11.
3. ☐ Hourly audit-chain anchor to object-locked R2 + paging verifier (§10) — tracked separately as known-outstanding at MVP, not by this exception.

**Close condition:** item 2 green in the `db-tests` workflow. → **Met. Closed 2026-08-01.**

### Closed 2026-08-01

The regression test now runs on every push. What it locks in is narrow and deliberate: it asserts the **chain** — digest well-formed, `prev_hash` links, caller-supplied `hash`/`prev_hash` overwritten by the trigger, per-tenant chains, no UPDATE, no DELETE — and never that an API call returned 200. During the outage every call returned 200. A test written against the response would have been green for all twelve migrations the chain was silently broken.

Item 3 (the R2 anchor and paging verifier) stays open as known-outstanding at MVP and is not gated by this entry. Worth stating plainly: until it lands, the chain is **tamper-evident to anyone who reads it, but nothing reads it on a schedule**. The trigger makes forgery detectable; the anchor is what makes it *detected*.

---

## EXC-004 — Deployed with none of the runbook §7 WAF rules in place

**Pillar:** 1 (Security) — CLAUDE.md §3 (Pillar 1, "WAF/rate limits"), §7; launch runbook §7.
**Opened:** 2026-08-01 · **Owner:** Developer (tech@purecoffee.sa) · **Expiry:** 2026-09-01 (30 days).

### What is missing

The Worker is deployed and publicly reachable at `https://braiin-station.braiin.workers.dev`. **None** of the six runbook §7 rules exist:

| Rule                                    | Required by                     | Status |
| --------------------------------------- | ------------------------------- | ------ |
| `/api/search` 30/min/IP → block         | §3 Pillar 1                     | absent |
| `/api/ai/style-finder` 60/hr/IP → block  | §3 Pillar 1                     | absent |
| `/api/hooks/notify-lead` rate-limit      | §3 Pillar 1, §10                | absent |
| `/api/analytics`, `/api/rum` rate-limit  | §3 Pillar 1                     | absent |
| Block training crawlers (6 tokens)       | §3 Pillar 3 (three-tier policy) | absent |
| Allow retrieval crawlers (4 tokens)      | §3 Pillar 3                     | absent |

### Why (justification)

Not a decision — a **hard blocker**. Cloudflare WAF custom rules and rate-limiting rules are **zone-scoped**, and `braiinstation.com` currently has no NS records at all: the domain is not delegated to Cloudflare, so the account has no zone to attach a rule to. `*.workers.dev` sits in Cloudflare's own zone, not the customer's, and cannot carry customer WAF rules. There is no configuration that closes this before DNS cutover.

### What still holds, and what genuinely does not

Precision matters here, because "no WAF" reads worse than it is and better than it is, in different places.

**Intact** — every one of these endpoints keeps its correctness defenses, all of which are in code and all of which are deployed:

- `/api/search` — Zod cap (≤64 chars, no control chars), `websearch_to_tsquery` (never raw `to_tsquery`), per-call `statement_timeout`, capped rows.
- `/api/analytics`, `/api/rum` — same-origin check, Zod envelope, **server-side** consent re-check (the client's beacon decision is not trusted).
- `/api/hooks/notify-lead` — bearer token, constant-time compared; verified live: an unsigned POST returns **401**.
- `/api/ai/style-finder` — the only public endpoint with a code-level limiter (per-IP 60/hr + per-session 20/hr) ahead of the spend cap.

**Genuinely absent** — the **volumetric** layer, everywhere except style-finder. That layer was designed to live in the WAF, and `src/pages/api/search.ts:21` says so in a `TODO(KAN-20)`. Two consequences worth naming rather than implying:

1. `/api/analytics` and `/api/rum` are unauthenticated paths to a **service-role write**. The same-origin check is the only volumetric friction, and an `Origin` header is trivially forged by anything that is not a browser — so it is not one.
2. `robots.txt` is served correctly from the code-owned crawler map, but robots.txt **asks**. The WAF is what **enforces**. Until it exists, the training-crawler deny list is a request, not a control.

Bounding the exposure: the origin is an unadvertised workers.dev subdomain with no inbound links, no custom domain and no traffic. That is obscurity, which is not a control either — it is the reason this is a 30-day exception and not an incident.

### Remediation plan (clears this exception)

1. ☐ Register/delegate `braiinstation.com` to Cloudflare; confirm the zone is active.
2. ☐ Add the custom domain to the Worker; rebuild with `PUBLIC_SITE_URL=https://www.braiinstation.com` (it is inlined at build time — a binding cannot override it) and redeploy.
3. ☐ Create all six rules from runbook §7. Cross-check the crawler tokens against `src/lib/seo/crawlers.ts`, the one code-owned map `tests/seo/crawlers.spec.ts` snapshots.
4. ☐ Verify by observation, not by reading the dashboard: 31 requests in a minute to `/api/search` gets a block; a `User-Agent: GPTBot` request gets a block; a `User-Agent: PerplexityBot` request does not.

**Close condition:** all six rules exist on the live zone **and** step 4's three observations pass. Nothing here is testable in CI — `tests/seo/crawlers.spec.ts` pins the code-owned map, and by design nothing can pin the WAF, which is exactly why this needs an observed check rather than a merged diff.

---

## EXC-005 — `js-yaml` quadratic-CPU advisory allowlisted in the production audit gate

**Pillar:** 1 (Security) — CLAUDE.md §3 (supply chain), §11.
**Opened:** 2026-08-22 · **Owner:** Developer (tech@purecoffee.sa) · **Expiry:** 2026-11-30.

### What changed

`GHSA-5p4m-2wfm-xmqj` (HIGH — quadratic CPU consumption resolving `!!omap` tags, affecting js-yaml 3.x and 4.x) entered the advisory database on 2026-08-22 and turned the blocking prod-scope gate red on a commit that touched no dependency. It is now a documented, expiring `ALLOWLIST` entry in `scripts/audit-gate.mjs`.

### Why not fix (measured, not assumed)

The fix exists only in `js-yaml@5`, which is ESM-only with **named exports**. Astro (`astro` and `@astrojs/internal-helpers`, the two consumers that put it in the prod tree) imports it as a default export, so a scoped override `"js-yaml@4": "^5.3.0"` was tried and **breaks `astro check` and `astro build` outright** (`The requested module 'js-yaml' does not provide an export named 'default'`). The 4.x line tops out at 4.3.0, which is inside the affected range — there is nothing safe to pin to.

### Why the residual risk is acceptable

The exposure is **build-time parsing of repo-authored YAML frontmatter only**. No runtime code path feeds user input to js-yaml — CMS content is JSON validated by Zod (`packages/schemas`), the contact API is Zod-validated JSON, and the Worker bundle's YAML use is Astro's frontmatter loader. Exploiting quadratic `!!omap` resolution requires a malicious YAML document **already committed to this repository**, at which point CPU consumption is not the attacker's best option.

### Remediation plan (clears this exception)

1. ☐ Watch for Astro adopting `js-yaml@5` (or an interchange like `yaml`) upstream — a routine Renovate bump clears this.
2. ☐ Alternatively, a backported 4.x release (`>4.3.0`) — then a plain override suffices.

**Close condition:** `npm run audit` reports 0 unallowlisted high/critical with the `GHSA-5p4m-2wfm-xmqj` entry REMOVED from `scripts/audit-gate.mjs`. If neither path lands by expiry, re-justify — never extend silently.

### Closed 2026-09-25

Path 2 landed: **js-yaml 4.3.2** is a 4.x release that fixes GHSA-5p4m-2wfm-xmqj, and the
gate started reporting the allowlist entry as stale. It arrived during the 2026-09 advisory
sweep (`fix/deps-2026-09`, which also cleared a CRITICAL Astro RCE through AVIF image
optimization, GHSA-26w7-cxv4-gfx2). The entry is removed from `scripts/audit-gate.mjs` with
a comment saying why, and `npm run audit` reports 0 high/critical in production deps. The
Lighthouse CI copy (js-yaml 3.x, dev-only) is pinned forward to `^3.15.2` by an override
for the separate GHSA-2883-xcg3-v3hh.

---

## EXC-006 — `extract-zip` path-traversal advisory allowlisted in the dev audit gate

**Pillar:** 1 (Security) — CLAUDE.md §3 (supply chain), §11.
**Opened:** 2026-08-22 · **Owner:** Developer (tech@purecoffee.sa) · **Expiry:** 2026-11-30.

### What changed

`GHSA-jmr9-qjv8-65gv` (HIGH — unvalidated symlink path traversal on extraction) flags `extract-zip` with an affected range of `*`: **every published version is vulnerable** and npm's only proposed "fix" is downgrading `@lhci/cli` seven majors to 0.6.1 — the same category of wrong answer the `tmp` override history in EXC-001 documents. It is now a documented, expiring `ALLOWLIST` entry in `scripts/audit-gate.mjs` (dev scope; the package is not in the prod tree).

### Why the residual risk is acceptable

`extract-zip` reaches the tree as `@lhci/cli` → chrome-launcher tooling, and runs in exactly one situation: unpacking the Chrome-for-Lighthouse archive that Lighthouse CI downloads from Google over TLS, on dev machines and CI. The archive is not attacker-controlled; exploiting the traversal requires substituting the zip, which requires defeating TLS to Google first. The package never ships in the Worker.

### Remediation plan (clears this exception)

1. ☐ Watch for `extract-zip` publishing a fixed release, or `@lhci/cli` swapping extractors — either clears this via a routine bump.

**Close condition:** `npm run audit:all` reports 0 unallowlisted high/critical with the `GHSA-jmr9-qjv8-65gv` entry REMOVED from `scripts/audit-gate.mjs`. If nothing lands by expiry, re-justify — never extend silently.

### Re-scoped 2026-09-25 — a second advisory against the same package

**GHSA-7pqw-9j4j-h8q3** (arbitrary file writes through symlink archive entries) was
published against `extract-zip`, affected range `<=2.0.1` — every release; the package has
not published since 2023. Same package, same single call site (`@lhci/cli` unpacking the
Chrome-for-Lighthouse download from Google over TLS), same dev/CI-only exposure, so it is
allowlisted under this exception with the same expiry rather than as a new one. The close
condition now requires **both** entries removed.

---

## EXC-007 — Visible motion pause control removed from the hero

**Pillar:** the Definition of Done, point 4 (Accessible — WCAG 2.2 AA). CLAUDE.md §4, §9 (axe WCAG 2.2 AA zero violations).
**Opened:** 2026-08-24 · **Owner:** Kareem (kareem@floppytech.ai) · **Expiry:** 2026-11-24
**Status:** Open

### What was weakened

`.motion-toggle` — the small pause/play control in the hero's bottom corner — has been removed from `src/components/sections/Hero.astro` and its rules deleted from `public/styles/global.css`.

That control was the **only** pause mechanism on the page, and it governed three things at once through `body.motion-paused`:

1. the hero background video loop,
2. the slogan-band background video (same sync group), and
3. the clients marquee (`body.motion-paused .marquee-track`).

All three start automatically, loop indefinitely, and are presented alongside other content. **WCAG 2.2.2 Pause, Stop, Hide (Level A)** requires a mechanism to pause, stop, or hide such content. There is now no such mechanism for any visitor who has not set `prefers-reduced-motion` at OS level. This is a **Level A** failure — a lower bar than the AA the standard otherwise holds, which is why it is recorded rather than absorbed.

### Why

Visual parity with the approved **Brain Station UI** reference (`Brain Station UI/index.html`), whose hero ships `<video muted loop playsinline autoplay preload="auto">` and no pause control of any kind. The control was the single visual difference between the shipped hero and the approved design.

The decision was made explicitly by the owner after the WCAG conflict, the Level-A severity and two compliant alternatives (relocating the control to the site header; revealing it on hover/focus) were presented and declined. Recording it here is the §11 requirement: *"flag and propose, rather than ship something that fails a pillar"* — the flag was raised, the trade was chosen with the cost stated, and it is logged rather than silent.

### What still holds

- **`prefers-reduced-motion` is fully honoured and is untouched.** `src/lib/client/lazyVideo.ts` returns before attaching any `<video>` at all for those visitors — they get the still poster, never video bytes — and `global.css`'s reduced-motion block freezes the marquee. This covers the visitors most likely to be harmed by vestibular triggers, but it is **not** a substitute: 2.2.2 is not conditioned on a user preference being set.
- **The mechanism is retained, only the control is gone.** `setMotionPaused()` in `lazyVideo.ts` and `body.motion-paused .marquee-track` in `global.css` are deliberately kept despite having no caller, so restoring compliance is a `<button>` plus one listener rather than re-plumbing three subsystems.

### Detection gap — read this before trusting CI

**No existing gate catches this.** `tests/a11y/axe.e2e.ts` will stay green: axe-core has no rule for "autoplaying media without a pause mechanism", because that determination is not machine-decidable. Lighthouse's accessibility category will also stay at 100. The CLAUDE.md §9 claim of "axe WCAG 2.2 AA zero violations (blocking)" is therefore **not** evidence of 2.2.2 compliance, here or anywhere else in this codebase. Do not close this entry on the strength of a green a11y run.

### Close condition

Any **one** of:

1. A pause/stop mechanism is restored anywhere on the page and is perceivable to mouse, keyboard **and** touch users — the site header, next to the language switch, was the recommended home and needs no hero changes; or
2. The hero, slogan-band and marquee motion is changed so 2.2.2 no longer applies (each stops within 5 seconds, or does not start automatically); or
3. Legal/design sign-off accepts the Level-A failure permanently, in which case the CLAUDE.md §4 DoD point 4 wording is amended to say so — the standard must not keep claiming WCAG 2.2 AA while a Level A criterion is knowingly unmet.

**Watch for:** anyone adding a new autoplaying background video, marquee or carousel. Under this exception they will inherit no pause affordance and will not be warned by CI.
