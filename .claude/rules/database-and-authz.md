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
- **Every table:** `id`, `tenant_id uuid NOT NULL`, timestamps, `created_by`/`updated_by`. RLS `ENABLE` **and** `FORCE` at creation. Every policy `USING`/`WITH CHECK` includes `tenant_id = (select auth.current_tenant_id())`.
- Role + `tenant_id` come from `app_metadata` via the Custom Access Token Hook — **never** `user_metadata`. Force-revoke sessions on role/tenant change.
- Publish/archive/delete gated by **RESTRICTIVE** RLS, not hidden buttons.
- **Lead PII** (`budget`/`timeline`/`internal_notes`/`ip_inet`): Admin + Developer only — column GRANT + `leads_safe` view (omits them; **not** granted to all `authenticated`) + role-checked decrypt path as the gate of record. Content Creator & SEO get **zero** lead access.
- **Anon tenant fence:** anon `tenant_id` resolves **server-side** (GUC / fixed anon-JWT claim), never client-chosen. Public writes go through `submit-contact-form`.
- **Migrations are forward-only** (expand/contract). Never edit an already-applied migration — add a new one.
- `audit_log` is append-only + HMAC-hash-chained by a `BEFORE INSERT` trigger; no UPDATE/DELETE. Key in Vault.
- Privileged/RLS-bypassing endpoints (`export-backup`/`export-csv`) **live-recheck** `profiles.role`/`is_active`/`locked_until`, rate-limit (3/hr/user + tenant aggregate), and write two audit entries.

**Tests ship with the change (§9):** pgTAP RLS per role/table + Edge `{role×capability}` matrix over `admin, content_creator, seo, developer, anon, other_tenant`. `other_tenant` = **deny on every row**; cross-tenant = zero rows. 100% branch coverage on authz + schema modules.
