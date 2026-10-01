# Security Exceptions Register

Documented, time-boxed exceptions to the engineering standard, per **CLAUDE.md §11** ("flag and propose … a documented exception with an owner and expiry"). The pillar order **Security > Performance > SEO > Scalability** is never _silently_ weakened — every deviation is recorded here with an owner, a justification, and an expiry, and is revisited on or before that date.

Every entry carries a **close condition** as well as an expiry. An expiry alone rots: EXC-001 sat open for six weeks after the thing blocking it (a Node 20 baseline) had already been removed by unrelated work, because nothing stated what to watch for. State the condition concretely enough that someone doing adjacent work trips over it.

| ID      | Opened     | Owner                          | Expiry     | Status | Summary                                                                                     |
| ------- | ---------- | ------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------------------- |
| EXC-001 | 2026-06-14 | Developer (tech@purecoffee.sa) | 2026-09-12 | **Closed 2026-08-01** | `npm audit` high+ gate was advisory. Tree is now 0 high / 0 critical; gate is blocking in both scopes |
| EXC-002 | 2026-08-01 | Developer (tech@purecoffee.sa) | 2026-08-15 | **Closed 2026-08-01** | Migration `0011` (schema `app` grants) shipped ahead of its pgTAP suite — suite now green in CI |
| EXC-003 | 2026-08-01 | Developer (tech@purecoffee.sa) | 2026-08-15 | **Closed 2026-08-01** | Migration `0012` (audit-chain `hmac`) shipped ahead of its regression test — test now green in CI |
| EXC-004 | 2026-08-01 | Developer (tech@purecoffee.sa) | 2026-12-24 | Open (re-justified 2026-09-25; first expiry 2026-09-01 lapsed) | Live on `*.workers.dev` with **no WAF rate limits and no crawler blocks** — both are zone-scoped and there is no zone |
| EXC-005 | 2026-08-22 | Developer (tech@purecoffee.sa) | 2026-11-30 | **Closed 2026-09-25** | `js-yaml` GHSA-5p4m-2wfm-xmqj allowlisted in the prod audit gate — js-yaml 4.3.2 shipped the 4.x fix; entry removed |
| EXC-006 | 2026-08-22 | Developer (tech@purecoffee.sa) | 2026-11-30 | Open (re-scoped 2026-09-25) | `extract-zip` GHSA-jmr9-qjv8-65gv **+ GHSA-7pqw-9j4j-h8q3** allowlisted in the dev audit gate — every published version is affected |
| EXC-007 | 2026-08-24 | Kareem (kareem@floppytech.ai)  | 2026-11-24 | Open (re-signed 2026-09-29; control built and removed) | Hero pause control **removed** — autoplaying hero/slogan video + clients marquee (and, from the UI v2 port, every banner/in-view video loop; from Round 2, the discipline card clips, the `/services` explorer clip and the service hero loops) had no pause mechanism for non-reduced-motion users (**WCAG 2.2.2, Level A**). A header control was built (Round 3, R3-7) and removed the same day at the owner's decision for mockup parity; the `body.motion-paused` wiring stays |
| EXC-008 | 2026-09-30 | Kareem (kareem@floppytech.ai)  | 2026-12-31 | Open | Join CVs (PDF / .docx, ≤ 10 MB) are stored and downloaded **without a virus scan** — no AV service on the free tier. Compensated by a structural check at upload, a private bucket, attachment-only download under a sandbox CSP, and a "Not virus-scanned" badge |
| EXC-009 | 2026-09-25 | Kareem (kareem@floppytech.ai)  | 2026-12-24 | Open (re-signed 2026-09-29) | Background video served as a **self-hosted MP4** (`/media/showreel.mp4`, 12.2 MB, `preload="auto"` at mount), not Cloudflare Stream — Stream is unprovisioned (KAN-20). Round 2 adds the discipline card clips, the explorer clip and the service hero loops |

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

### Re-justified 2026-09-25 — the first expiry lapsed unnoticed

The 2026-09-01 expiry passed with the entry still open and nobody revisiting it. That is
the failure this register exists to prevent, so the lapse is recorded rather than quietly
re-dated. **Nothing in the remediation plan has moved:** `braiinstation.com` is still not
delegated, so there is still no zone to hold a rule.

What changed is the exposure. The UI v2 port (plan `check-latest-folder-in-dazzling-widget`)
adds a **second public write path** — `/api/apply`, a multipart job application with a CV
upload — and `/api/contact` has had no volumetric control of any kind since launch. Both
are unauthenticated paths to a service-role write. Waiting for the zone is no longer an
acceptable answer for those two, so the exception is **narrowed by a code-level control
that does not need a zone**:

- ☑ **Limiter on `/api/contact` and `/api/apply`** (Join, 2026-09-30 — migration 0029,
  `src/lib/http/publicRateLimit.ts`): a service-role Postgres counter
  (`public_write_attempts`, bumped atomically by `public.public_write_hit()`, keyed by an
  HMAC of the address or e-mail — never the raw value — and purged after 48 h by the
  Worker's daily cron). `/api/apply`: 5 per hour per address and 3 per day per e-mail,
  **fails closed**. `/api/contact`: 10 per hour per address, **fails open** (a lost lead is
  worse than an unthrottled minute). **One ring, not the two this entry first named:** the
  Workers Rate Limiting binding was not adopted — the Postgres counter is the authoritative
  count across isolates, and the per-second ring arrives with the WAF and the zone.
- **Hard rule:** `/api/apply` does not ship without that limiter in front of it. *(Held:
  it shipped with it.)*

The four WAF rows for search, style-finder, the hooks and the telemetry beacons, and both
crawler rows, remain open under the original remediation plan — the code limiter is not a
substitute for them.

**New expiry 2026-12-24.** Close condition unchanged.

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
**Status:** Open — **re-signed 2026-09-29** for the widened scope (expiry 2026-11-24, not extended); the header control was built and removed the same day (below)

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

### Widened 2026-09-25 — the UI v2 port trips the "watch for" note

The new Brain Station UI delivery (7 pages; plan `check-latest-folder-in-dazzling-widget`)
adds motion on almost every page. The owner chose **parity with the mockup** again
(decision 2), with one addition: the testimonials carousel gets its own pause/play button.
The scope of this exception therefore grows to cover, **as each surface ships**:

| Surface | Where | Motion |
| --- | --- | --- |
| Banner hero loops | `/contact` (already live), `/join`, `/portfolio`, `/portfolio/[slug]` | autoplaying muted video window |
| In-view clip loops | home Selected Work (featured + 2 cards), about "Who we are", Our Work intro (×2), case-study final film | muted loop while on screen |
| Clients marquee | home (already covered), `/portfolio` | continuous CSS scroll |
| Banner caption dot | `/portfolio`, `/portfolio/[slug]` (UI v2 PR11) | pulsing indicator |

**Compliant, and NOT under this exception** (each must stay that way):

- **Testimonials carousel** — visible pause/play control beside its arrows; pauses on hover;
  keyboard focus entering it stops the rotation until Play is pressed (APG — focus leaving
  does not restart it); stops when off-screen; never auto-advances under
  `prefers-reduced-motion`.
- **Card hover previews** — user-initiated, stop on pointer-leave / blur, and pausable (since
  Round 3 the header switch stops them too); never autoplay on touch.
- **Count-up numbers and scroll reveals** — finish in under 5 s (2.2.2 does not apply).
- **Leadership slider and case-study lightbox** — no autoplay.

**Invariants that still hold across every surface above:** no video element or bytes at
all under `prefers-reduced-motion` or Save-Data; zero video bytes before intersection
(now asserted by `tests/e2e/media-bytes.e2e.ts`); in-content clips never autoplay on touch.

⚠ **Owner re-sign required.** The widened scope is a new, larger Level-A failure than the
one signed on 2026-08-24; this entry must be re-signed (and its expiry revisited) before
the first new surface merges. The close conditions above are unchanged — the header pause
control remains the one-button fix for all of it (`setMotionPaused()` is still retained).
*(Overtaken: see 2026-09-29 below.)*

### Widened 2026-09-27 — Round 2 (services redesign)

The Round 2 delivery (`index.html` v2.1, `services.html`, `service.html`; plan
`check-latest-folder-in-dazzling-widget`, "Round 2") adds three more video surfaces. The
owner again chose parity with the mockup. Each plays a window of the showreel, stored in
the database as a `preview_video_path` clip (migration 0028: `disciplines`, `services`):

| Surface | Where | Motion |
| --- | --- | --- |
| Discipline card clips | home "What we do", `/services` cards (5 cards) | muted loop while the card is hovered or focused |
| Explorer clip | `/services` tabbed explorer (sticky media, one per open discipline; swaps on row hover/focus) | muted loop while the explorer is open and on screen |
| Service hero loops | `/services/[slug]` (28 pages, EN + AR) | autoplaying muted banner loop, the service's own window |

The card clips are user-initiated (hover/focus), like the card hover previews above, and
stop on pointer-leave or blur. They are listed here anyway: focus alone starts them, and a
keyboard user tabbing through the row starts one clip after another. The explorer clip and
the service hero loops autoplay with no pause control, which is squarely the 2.2.2 failure
this entry records.

**Invariants unchanged:** no video under `prefers-reduced-motion` or Save-Data; zero video
bytes before intersection (the Round 2 slices add these surfaces to
`tests/e2e/media-bytes.e2e.ts`); in-content clips never autoplay on touch.

⚠ **Owner re-sign required again** before the Round 2 PRs merge. The header pause control
would still fix every surface at once. *(Overtaken: see 2026-09-29 below.)*

### 2026-09-29 — built, then removed at the owner's decision; widened scope re-signed

**What stands:** the control described below shipped in PR #26 and was removed the same
day in PR #27 — the owner, seeing the button in the live header, chose the mockup's header
over it ("keep the header matching the mockup"). `src/lib/client/motion.ts`, the
subsystem wiring (lazyVideo, clips, carousel) and the `body.motion-paused` CSS rules stay
with no writer, so restoring the control is `SiteHeader.astro` plus one script. **That
decision is the owner's re-sign of the 2026-09-25 and 2026-09-27 widenings:** scope as
listed above, expiry 2026-11-24 unchanged (not extended), close conditions unchanged. The
rest of this section records what the control did while it existed.

Neither widening (2026-09-25, 2026-09-27) had been re-signed before that: the UI v2 and Round 2
surfaces shipped with the entry still marked "owner re-sign pending". At the Round 3 plan
review (G3, "do what you see best fit") the owner's sign-off was to close the failure
rather than re-sign it a third time. Close condition 1 was met as written, in the place it
recommended: **the site header, next to the language switch**. Round 3 (plan `check-latest-folder-in-dazzling-widget`, item F,
design-port decision R3-7; the owner's G3 answer) adds a 32 px icon button after the
language pill on every page — `src/components/SiteHeader.astro`, one fixed accessible name
("Pause motion" / "إيقاف الحركة") plus `aria-pressed`, perceivable to mouse, keyboard and
touch users, remembered per tab in `sessionStorage` (`bs_motion`, a functional setting, no
consent gate). Its state is `body.motion-paused`, owned by the new `src/lib/client/motion.ts`
(no imports, so the header never pulls video code) and broadcast as a `motion-updated`
event that each moving subsystem subscribes to.

"A button plus one listener" turned out to be true only for the two surfaces this entry
was opened on. The retained `setMotionPaused()` covered the background loops and the
marquee; every surface widened in since then needed its own wiring, which is what the
close actually took:

| Surface | Before | Now |
| --- | --- | --- |
| Hero / slogan / banner / service hero loops (`lazyVideo.ts`) | paused, but still **mounted** (`preload="auto"` + `src`), so a paused visitor downloaded the file | paused, and the mount is **deferred** until resume (a pending set) — a paused visitor downloads nothing (`tests/e2e/media-bytes.e2e.ts`, "paused visitor") |
| In-view clips, card hover clips, the explorer clip (`clips.ts`) | never checked the class | `play()` returns before creating the `<video>`; the visibility handler and `retargetClip` are guarded; a global pause stops every frame, a resume plays the frames still wanted |
| Clients marquee (`global.css`) | already paused under the class | unchanged |
| Hero scroll cue (`.hero__scroll i`), banner caption dot (`.work-cap__live::after`) | no rule | `animation-play-state: paused` under the class (`global.css`, `banner.css`) |
| Testimonials carousel (`carousel.ts`) | its own APG control | composes: a global pause sets its `userPaused` so its own button honestly shows Play; a global resume leaves it stopped (only its own Play restarts it); it starts stopped when the page is already paused |

Deliberately **not** a blanket `body.motion-paused *`: a paused choice restored on home
would freeze the intro plate opaque and the hero entrances at their from-frame. The button
is hidden by CSS under `prefers-reduced-motion` (nothing moves there — no video mounts,
the loops are static) and under `@media (scripting: none)`; it is never shown or hidden by
script after first paint (`tests/e2e/layout-shift.e2e.ts`).

**The detection gap above still holds** and is now covered by a test instead of a
register entry: `tests/e2e/motion-pause.e2e.ts` (EN + AR) asserts the name and pressed
state, click / Space / Enter / tap, every `<video>` paused and the three CSS loops held,
no clip created by a full scroll or a card hover while paused, the on-screen hero alone
resuming, the choice surviving navigation but not a new tab, the button hidden under
reduced motion, and the carousel composition. axe still cannot decide 2.2.2 — a green
a11y run is still not evidence of it; that test is.

**Watch for (the standing rule that replaces this entry):** any new autoplaying video,
CSS loop or carousel must stop under `body.motion-paused` — a `<video>` through
`lazyVideo.ts`/`clips.ts`, a CSS loop through an `animation-play-state: paused` rule
under the class, a script-driven motion through `onMotionChange()` — and must add itself
to `motion-pause.e2e.ts`. The header switch is the one 2.2.2 control; a surface that
ignores it reopens this failure without any gate noticing.

---

## EXC-008 — Job-application CVs are not virus-scanned

**Pillar:** 1 (Security) — CLAUDE.md §3 (every public form validated server-side) and the
Join design's AV requirement.
**Opened:** 2026-09-30 · **Owner:** Kareem (kareem@floppytech.ai) · **Expiry:** 2026-12-31
**Status:** Open

### What deviates
The Join form (`/join`, `/ar/join`; `src/pages/api/apply.ts`) accepts a CV of up to 10 MB,
stores it in a private Supabase Storage bucket and lets an Admin download it. No antivirus
engine looks at it at any point: there is none on the Cloudflare Workers free plan or the
current Supabase plan, and the owner chose the free route (decision J1, 2026-09-30).

### What still holds (compensating controls)
- **A structural check before anything is stored** (`src/lib/applications/fileSniff.ts`):
  the bytes, not the browser's type or the file name, decide. A PDF must start `%PDF-` and
  end `%%EOF`. A `.docx` is checked the way Word reads one, not the way Word usually writes
  one: the ZIP must be unambiguous (nothing before or after the archive, no duplicate names
  or shared data, local headers that agree with the directory, no encrypted entries); the
  main document is the one the package's `_rels/.rels` names, and a plain Word document;
  and **every** part's declared content type and **every** relationship in every
  `_rels/*.rels` is checked, wherever it lives. Refused: macros (a VBA project, a
  macro-enabled type), ActiveX, an embedded object other than a native chart's own
  workbook, an altChunk or subdocument, a mail-merge data source, and any link out of the
  file other than a hyperlink or a template on the author's own disk (the remote-template
  attack: a web address or a network share is refused). Relationship XML is read by its
  attribute grammar with references decoded; UTF-16, NUL bytes and DTDs are refused. The
  work is bounded (64 relationship files, 2 MB inflated in total) for the free plan's CPU.
  Legacy `.doc` is refused outright — its macros cannot be checked without parsing the
  whole compound file. (Hardened 2026-10-01 after an independent review found the first
  version looked only where Word usually puts things.)
- **Nobody but an Admin can reach a file:** the bucket is private, no storage policy names
  it (a RESTRICTIVE belt where the migration role may add one), and the only way out is
  `GET /api/admin/applications/[id]/cv` — `applications.pii`, live-rechecked,
  rate-limited and audited before the file is sent.
- **The browser never renders it:** `Content-Disposition: attachment`, `nosniff`,
  `no-store`, and a CSP `sandbox` (kept by `applySecurityHeaders`) for a URL opened in a tab.
- **The reviewer is told:** the admin panel puts "Not virus-scanned" beside every download.
- **What it does not cover:** a PDF exploit aimed at the reader that opens it, and field
  codes in a `.docx`'s text (DDE, INCLUDEPICTURE — the check never reads the document body;
  Word asks before it updates them, and Protected View holds a downloaded file until
  editing is enabled). That is the residual risk this entry records; open CVs in an
  up-to-date reader, keep Protected View on, and do not enable editing for a CV you do not
  need to edit.

### Close condition
An antivirus scan runs on every CV before it is downloadable (a scanning service or a
provider feature), and the panel's badge is driven by its verdict.

## EXC-009 — Background video self-hosted as MP4 instead of Cloudflare Stream

**Pillar:** 2 (Performance) — CLAUDE.md §3 Pillar 2 ("Video via Cloudflare Stream only;
poster is the LCP `<img>`; `preload="none"`"), §6.
**Opened:** 2026-09-25 · **Owner:** Kareem (kareem@floppytech.ai) · **Expiry:** 2026-12-24
**Status:** Open (re-signed 2026-09-29)

### What deviates

- The hero and slogan background loops play `/media/showreel.mp4` — a **12.2 MB static
  file** in `public/` — not a Stream rendition. It has been described as "a documented
  temporary exception pending Stream (KAN-20)" in `Hero.astro` and in commit `2caf2d1` since
  2026-08-22, but it was never actually entered in this register. This entry is that record.
- `src/lib/client/lazyVideo.ts` sets `preload = 'auto'` **at mount time**. The standard's
  `preload="none"` is honoured in the sense that matters — no `<video>` exists in the
  served HTML, so nothing preloads at parse — but once a surface mounts, the browser is
  free to fetch aggressively.
- The UI v2 port multiplies the surfaces. Clip windows (a start/end window of the same
  file, e.g. 6.2–7.9 s) back the contact/join/work/case-study banners and the in-view
  clips. The CMS encodes this deliberately: a `VideoClip` is **either** a Stream UID **or**
  a `path` matching `^/media/[a-z0-9][a-z0-9/_-]*\.mp4$` — that allow-list is the DB-level
  fence of this exception.

### Why

Cloudflare Stream is not provisioned (KAN-20). The alternative is no video at all, which
the approved design does not accept.

### What still holds (compensating controls)

- **Zero video bytes before intersection** — now CI-asserted, not just intended
  (`tests/e2e/media-bytes.e2e.ts`, added 2026-09-25). Its first run is what moved the slogan
  band from "preload one viewport early" (`rootMargin: '100% 0px'`) to mount-on-intersection.
- No video bytes at all under `prefers-reduced-motion` or Save-Data.
- The poster paints first; video mounts after `load` (hero) or on intersection (everything else).
- From UI v2 PR6: in-content clips never autoplay on touch, so mobile data plans pay for
  posters only.
- Every clip is a window of the **same** file, so a visitor downloads (ranges of) one asset,
  not one per surface.
- **Byte ranges (amended 2026-09-27).** The mp4 is served **through the Worker**, not by
  Workers Static Assets directly: `assets.run_worker_first: ["/media/*"]` (wrangler.jsonc)
  routes it to `src/worker.ts`, which answers `/media/*.mp4` from the `ASSETS` binding with
  `206` + `Content-Range` / `Accept-Ranges` (`416` when unsatisfiable, `HEAD` supported,
  `If-Range` honoured) — `src/lib/http/media.ts`, parsing in `src/lib/http/range.ts`. Until
  then the asset worker ignored `Range` (a `bytes=0-99` request got 200 and all 12,233,105
  bytes), Chromium reported `seekable` = [0, 0], and every clip window was silently dropped:
  each surface played the reel from 0 and pulled the whole file, so the "ranges of one
  asset" line above was not true in production. The route admits only the `VideoClip`
  allow-list (`StaticVideoPathSchema`, the same pattern as the DB CHECK), GET/HEAD only,
  forwards no client headers but the validators, and carries the middleware's security
  headers. It is an Astro-bypassing entry on purpose — the adapter answers every
  `dist/client` file before routing and drops `Range` — see the header of `media.ts`.
  Guarded by `tests/lib/range.spec.ts`, `tests/lib/mediaRoute.spec.ts` and
  `tests/e2e/media-range.e2e.ts` (206/200/416 on the wire, a seekable `<video>`, and the
  contact hero looping inside its 6.2–7.9 s window). Closing this exception (Stream)
  removes the route with the file.

### Close condition

All of:

1. Stream is provisioned (KAN-20) and every `VideoClip` in content uses `streamUid`;
2. the `/media/*.mp4` path branch is removed from the `VideoClip` schema (and its DB CHECK);
3. `public/media/showreel.mp4` is deleted;
4. mounted `<video>` elements use `preload="none"` or a Stream player facade.

### Widened 2026-09-27 — Round 2 surfaces (owner re-signed 2026-09-29, below)

Round 2 adds three surfaces, all windows of the same `/media/showreel.mp4`, so a visitor
still downloads ranges of one file:

- the **discipline card clips** on home and `/services` (5 windows, `disciplines.preview_*`);
- the **explorer clip** on `/services` (the discipline's window, swapped to a service's on
  row hover/focus);
- the **service hero loops** on the 28 `/services/[slug]` pages, EN and AR
  (`services.preview_*`).

The DB fence is the same allow-list as `portfolio.preview_video_path`: migration 0028 gives
`disciplines` and `services` a `preview_video_path` CHECK
(`^/media/[a-z0-9][a-z0-9/_-]*\.mp4$`) and a window CHECK (both-or-neither, end after
start, at most 30 s: `disciplines_preview_window`, `services_preview_window`). Posters are
`static` stills (`stills/services/*.jpg`) through `<Picture>`, readable by visitors only
while the discipline or service is published (0028's branches of
`media_assets_public_read`). The close conditions above now also cover these columns:
closing means Stream UIDs for all of them, and dropping the path branch from both CHECKs.
`services.hero_video_uid` (the Stream column since 0001) stays unused until then.

**Watch for (added with UI v2 PR11):** the case study's final film ships as a muted in-view
loop with no sound control; its Stream replacement (sound + captions, WCAG 1.2.2) is part
of closing this entry. That player — like every Stream facade — is third-party video and
must go through the single consent gate (`hasConsent`, CLAUDE.md §7) before it loads
anything. Today no Stream facade is rendered on the case study, so there is nothing to gate
there yet (`tests/e2e/case-study.e2e.ts` asserts no `<iframe>` / `.stream` in its HTML).

### Owner re-sign 2026-09-29

**Owner re-sign 2026-09-29: widened scope confirmed, expiry 2026-12-24 unchanged.** The
Round 3 plan review (G3) confirmed the Round 2 widening above; only Stream (KAN-20) can
close this entry, and the close conditions are unchanged. One compensating control was
added with the close of EXC-007: a visitor who pressed the header's motion switch
downloads **no video bytes at all** — the background loops defer their mount and the
clips never create their `<video>` while `body.motion-paused` is set, and
`tests/e2e/media-bytes.e2e.ts` ("paused visitor: no clip/banner bytes after a full
scroll") asserts it on every route it covers.
