---
paths:
  - 'supabase/migrations/**'
  - 'supabase/functions/**'
  - 'src/lib/authz/**'
  - 'src/pages/api/**'
  - 'src/pages/admin/**'
---

# Database, RLS & Authorization — load-bearing invariants

> Path-scoped reminder. **Canonical source: `CLAUDE.md` §3 (Pillar 1 — Security), §8 (Data model & schema), §5 (role matrix), §9 (testing). If this and CLAUDE.md disagree, CLAUDE.md wins.**

Security is the highest pillar — never weaken authz to hit a perf budget; file an exception (§11) instead. When you touch migrations, Edge Functions, or authz code:

- **Two independent server authz layers that must BOTH pass:** Postgres RLS (primary) + `assertCap()` in the Edge/API handler (secondary). React `can()` is UX only, never a security control.
- **Every table:** `id`, `tenant_id uuid NOT NULL`, timestamps, `created_by`/`updated_by`. RLS `ENABLE` **and** `FORCE` at creation. Every policy `USING`/`WITH CHECK` includes `tenant_id = app.effective_tenant_id()` (the real helper — there is no `auth.current_tenant_id()`).
- Role + `tenant_id` come from `app_metadata` via the Custom Access Token Hook — **never** `user_metadata`. Force-revoke sessions on role/tenant change.
- Publish/archive/delete gated by **RESTRICTIVE** RLS, not hidden buttons.
- **Lead PII** (`budget`/`timeline`/`internal_notes`/`ip_inet`): Admin + Developer only — staff tokens SELECT the safe columns only (column GRANT, 0033); the gated ones are returned to a person only by the audited reveal and export, both reading them as the service role, and are read without returning anything by two server-side processes, the signed `notify-lead` hook and the daily index backfill (`tests/lib/leadGrants.spec.ts` names every reader); a RESTRICTIVE live check (`app.live_role()`) re-reads the profile on every lead query; the role-checked decrypt path is the gate of record. `leads_safe` is SECURITY INVOKER and granted to all `authenticated` (a GRANT cannot tell the app roles apart; RLS decides its rows). Content Creator & SEO get **zero** lead access.
- **Anon tenant fence:** anon `tenant_id` resolves **server-side** (GUC / fixed anon-JWT claim), never client-chosen. Public writes go through `submit-contact-form`.
- **Migrations are forward-only** (expand/contract). Never edit an already-applied migration — add a new one. Apply a migration to production before its PR merges (the deploy guard refuses otherwise); a contraction (a revoked grant or dropped column the live code still uses) ships alone, in the PR after the code that stops using it (CLAUDE.md §8; launch runbook §5a).
- `audit_log` is append-only + HMAC-hash-chained by a `BEFORE INSERT` trigger; no UPDATE/DELETE. Key in Vault.
- Privileged/RLS-bypassing endpoints (`export-backup`/`export-csv`) **live-recheck** `profiles.role`/`is_active`/`locked_until`, rate-limit (3/hr/user + tenant aggregate), and write two audit entries.

**Tests ship with the change (§9):** pgTAP RLS per role/table + Edge `{role×capability}` matrix over `admin, content_creator, seo, developer, anon, other_tenant`. `other_tenant` = **deny on every row**; cross-tenant = zero rows. 100% branch coverage on authz + schema modules.
