# Security Exceptions Register

Documented, time-boxed exceptions to the engineering standard, per **CLAUDE.md §11** ("flag and propose … a documented exception with an owner and expiry"). The pillar order **Security > Performance > SEO > Scalability** is never _silently_ weakened — every deviation is recorded here with an owner, a justification, and an expiry, and is revisited on or before that date.

Every entry carries a **close condition** as well as an expiry. An expiry alone rots: EXC-001 sat open for six weeks after the thing blocking it (a Node 20 baseline) had already been removed by unrelated work, because nothing stated what to watch for. State the condition concretely enough that someone doing adjacent work trips over it.

| ID      | Opened     | Owner                          | Expiry     | Status | Summary                                                                                     |
| ------- | ---------- | ------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------------------- |
| EXC-001 | 2026-06-14 | Developer (tech@purecoffee.sa) | 2026-09-12 | Open (re-scoped 2026-08-01) | `npm audit` high+ gate advisory; shipped-deps **critical** still blocks. Now blocked only on `vitest` 2→4 |
| EXC-002 | 2026-08-01 | Developer (tech@purecoffee.sa) | 2026-08-15 | Open   | Migration `0011` (schema `app` grants) shipped ahead of its pgTAP suite — the site was down   |
| EXC-003 | 2026-08-01 | Developer (tech@purecoffee.sa) | 2026-08-15 | Open   | Migration `0012` (audit-chain `hmac`) shipped ahead of its regression test                    |

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
3. ☐ Per-role rows over `{admin, content_creator, seo, developer, anon, other_tenant}` for the four restrictive policies added in 0011 §5b.
4. ☐ Fix `rls_admin_cms.test.sql`'s `entity_seo` fixture — it points at a service id that never existed, so "anon reads entity_seo" currently passes for the wrong reason. It must seed a published **and** a draft entity and assert anon sees exactly the published one.

**Close condition:** items 3 and 4 merged and green in the `db-tests` workflow.

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
2. ☐ Verify the suite passes in CI against the local stack (no Docker on the current dev machine; unverified locally).
3. ☐ Hourly audit-chain anchor to object-locked R2 + paging verifier (§10) — tracked separately as known-outstanding at MVP, not by this exception.

**Close condition:** item 2 green in the `db-tests` workflow.
