# Admin v2 · A3 — Site-wide releases (pending changes → preview → publish → versions → rollback)

> **Status: design input to the Admin v2 program, written 2026-10-03.** Where this
> document and [README.md](README.md) disagree, README wins: its program decisions
> (P-1 to P-15) and the adversarial review in [verification.md](verification.md) were
> applied after this design was written. Design slice ids (R0 to R16) map to program
> slices in README's slice tables. Inputs it cites by file name (design.txt, grp-*.txt,
> linkage.txt, code-summaries.txt) were working notes of the mapping pass and are not
> in the repository; the client's prototype and ADMIN_TDD.md are the handoff.

## Summary

Every admin edit in a release-managed area is saved as a pending change. These areas are pages and sections, services, disciplines and service cases, Our Work, collections, blog, navigation, public identity, theme/chrome, SEO and redirects. Each entity has one shared pending change in a new `content_drafts` table. The live tables only change inside a release. Publish applies the selected pending changes in a single Postgres transaction through `public.apply_release`. By default it applies everything the person pressing Publish may publish, which matches the mockup's site-wide Publish; items can be opted out and dependencies are pulled in. `apply_release` is SECURITY INVOKER and only `service_role` may execute it. It runs as the publisher's live profile (it switches to that role inside the transaction), so RLS, every RESTRICTIVE publish/archive/delete gate, CHECKs and guard triggers bind exactly as for that user. Before calling it, the Worker re-validates every item: Zod, the resource domain rules, per-item `assertCap` and `liveRecheck`. Staff cannot skip that validation, and the stale-JWT gap is closed for publishing. No capability is added. An item is publishable by whoever holds its area's capability: content needs the write cap plus `content.publish`, removals and archives need `content.archiveDelete`, identity needs `settings.general`, theme needs `theme.edit`, SEO needs `seo.*` and redirects need `redirects.manage`. So releases add a review step without widening who can change the live site, and Sales is denied everywhere. A guard trigger refuses any staff JWT's direct write to a release-managed table outside a release. This closes today's PostgREST bypass of Worker validation. Conflicts are detected per column with a three-way check (draft base vs live) and come back as a 409 with Keep mine / Use live. Releases are numbered per tenant when they go live. An AFTER trigger captures before/after images of every row a release changes, cascades included, into `content_release_items`. `content_versions` gains `release_id` and now covers every release-managed table, and rollback means staging the state at vN as pending changes and publishing it as a new release. Scheduling moves from rows to releases. A scheduled release freezes a validated item list and locks its drafts. The Worker's minute cron fires it as the scheduler (re-checked live) and purges the cache, and legacy scheduled rows are converted at switch-on. I agree that maintenance stays an immediate, confirmed switch: it is a Pillar-1 kill switch checked before the cache, and it belongs to Developer, who must never publish content. Users, integrations, technical settings, `accepting_applications`, leads/CRM, job applications and media (binaries and metadata) also stay immediate. The cache purge seam is one module. A release purges the union of its items' tags, old and new slugs included: up to 30 tags individually, otherwise `tenant:default`. It is a logged no-op until the Cloudflare zone exists, failures are retried by the cron, and page tags become route tags plus the tags of the sections actually rendered. Preview is a Tier C route under `/admin/preview/**`. It uses the real public loaders and page components, but swaps the loaders' client for a request-scoped overlay that serves live rows plus re-validated drafts, filtered by a mirror of the public RLS rules. Preview responses are never cached and are noindex. The preview bridge script and `frame-src 'self'` exist only on admin responses. Rollout is expand → flag → contract, and CLAUDE.md §1/§2/§3/§5/§8/§9/§10 need the amendments listed.

Binding standard: CLAUDE.md (cited as §n). Tie-break: Security > Performance > SEO > Scalability (§3). The decision ids A3-1… go into a new "Admin v2 — Releases (A3)" section of `docs/design-port-2026-09.md` (the per-port decisions convention).

Verified against the code: `src/lib/admin/{crud,resource,resources,singleton,route}.ts`, `src/lib/data/*.ts` (25 `anonClient()` call sites in 15 loaders), migrations 0001/0009/0011/0016/0019/0021/0022/0025/0028/0029, `src/lib/http/{cacheTags,securityHeaders,redirects}.ts`, `src/middleware.ts`, the route tag lists (`HOME_CACHE_ENTITIES`, `SERVICES_CACHE_ENTITIES`, `serviceCacheEntities`, `CONTACT_/JOIN_CACHE_ENTITIES`, per-page `entities` arrays), `src/worker.ts`, `wrangler.jsonc`, `.size-limit.json`, `tests/authz/*`, `supabase/tests/*`. Cloudflare docs checked on 2026-10-03: purge by tag is available on every plan (Free: 5 purge requests/min, bucket 25). Entries stored with the Workers Cache API can be purged by `Cache-Tag`.

---

## 0. Decisions

| # | Decision | Why |
|---|---|---|
| A3-1 | **Stage everything in release-managed areas.** Every admin write to a release-managed table creates or amends a pending change in `content_drafts`. Live tables change only inside a release. | "Stage only edits that change public output" would need a TS/SQL oracle on the write path for RLS visibility, including the RESTRICTIVE fences (discipline published, parent published, visible). It would also leave live changes with no release record, purge or rollback point. One rule and one code path make "editing never changes the live site" literally true. |
| A3-2 | **One shared pending change per entity** (`unique (tenant_id, entity_type, entity_id)`). It has its own optimistic lock (`content_drafts.version`) and stores a `base` (the live values it started from) for column-level three-way conflict detection at publish. | Per-user branches would need merges. This extends §3 Pillar 4 optimistic locking. |
| A3-3 | **Publish = one atomic release.** The default selection is every pending item the presser may publish (site-wide, as in the mockup). The dialog lets them opt items out and auto-includes dependencies. If any item fails, the whole release aborts. | Owner A3, plus safety when several people edit at once. |
| A3-4 | **No new capability.** An item is publishable by holders of its area's capabilities (§4.1). The release model adds a review step and never widens who can change the live site. Sales: no access to anything here. | §5 stays the authority. `ROLE_CAPS` is unchanged, so the CI snapshot stays green. |
| A3-5 | **`public.apply_release` is SECURITY INVOKER with EXECUTE for `service_role` only.** It impersonates the publisher's *live* profile (`profiles.role/tenant_id/is_active/locked_until`) with `SET LOCAL ROLE authenticated` plus claims built from that profile. The Worker validates every item before calling it. | RLS, every RESTRICTIVE gate (0001/0007/0009/0018/0021/0028), CHECKs and guard triggers (0019/0025/0028) bind as that user (§3 Pillar 1 "two layers"). Staff cannot skip Worker validation by calling the RPC through PostgREST. The known stale-JWT gap (a demoted token passes RLS for up to 1 h) is closed for publishing. |
| A3-6 | **Release guard trigger** on every release-managed table. It refuses a staff JWT's direct INSERT/UPDATE/DELETE outside a release once the tenant has releases enabled. | Today any Admin or Content Creator can PATCH live rows through PostgREST and skip the Worker's Zod checks and sanitizers (for example `sanitizeHref` on nav hrefs). With the guard, every live change is a validated, recorded, purged and rollbackable release. |
| A3-7 | **Ledger.** `content_releases` gets a per-tenant `number`, assigned when the release goes live. `content_release_items` holds before/after row images written by an AFTER trigger, so cascades and side writes are captured. `content_versions` stays the per-entity history (§8: one polymorphic table, no page_versions), gains `release_id`, and now covers every release-managed table. | Rollback needs the before-image of everything a release touched. |
| A3-8 | **Rollback = "Restore vN".** The state at vN is staged as pending changes, previewed, then published as a new release (`kind = 'rollback'`). Per-item History restore works the same way for one entity. | Reuses every gate. It is also the mockup's own copy: "vN restored. Publish to make it live." |
| A3-9 | **Scheduling moves from rows to releases.** A scheduled release freezes a validated item list and locks its drafts. The Worker's minute cron fires it through the same RPC, as its scheduler, re-checked live at fire time, then purges. Legacy `status='scheduled'` rows are converted at switch-on, and `app.publish_scheduled()` skips enabled tenants. | One apply path. No SECURITY DEFINER write that bypasses RLS at fire time. |
| A3-10 | **Immediate, never staged:** maintenance (agreed — Pillar-1 kill switch), users/roles, integrations/secrets, `ai_config`, technical `site_settings`, `site_profile.accepting_applications`, leads/CRM core, job applications, media binaries **and** media metadata, Style-Finder authoring (until the quiz ships). | §1.2. |
| A3-11 | **One purge seam.** A release's tag set is the union of its items' tags, with old and new slugs: up to 30 tags individually, otherwise `tenant:default`. It is a logged no-op until a zone exists, and the minute cron retries failures. Page tags become route tags plus the tags of the sections actually rendered. | §2 "Publish = cache event, not a rebuild"; §3 Pillar 2 "purge by tag only". |
| A3-12 | **Preview is Tier C `/admin/preview/**`.** It uses the real loaders and page components. The loaders read through a request-scoped client (AsyncLocalStorage) that serves live rows plus re-validated drafts, filtered by a TS mirror of the public RLS rules. | §2 render tiers and DoD-3: Tier A code paths and caching are untouched, and preview responses are never cacheable. |
| A3-13 | **Drafts are untrusted input.** They store the camelCase payload. Overlay, preview and publish all re-parse it with the entity's Zod schema and `toRow`. | §8 "Zod is the single content boundary". Drafts are staff-writable through PostgREST under RLS. |
| A3-14 | **Switched on per tenant by the runbook** (`app.enable_releases`). It writes a baseline v1, converts scheduled rows and arms the guard; the flag is `site_settings.releases_enabled`. Expand → flag → contract. | §8 forward-only migrations; reversible until the contract slice. |

---

## 1. Scope

### 1.1 Release-managed entity types

SQL source: `app.release_entities`. TS source: `src/lib/release/registry.ts`, kept in parity by tests.

| entity_type | table | area | may stage (RLS author roles = today's write policy) | may publish (all caps required) | remove / archive | cache tags (from before AND after rows) | order |
|---|---|---|---|---|---|---|---|
| category | categories | Blog | admin, content_creator | categories.manage + content.publish | content.archiveDelete (RESTRICTIVE 0018) | blog:all | 10 |
| sector | sectors | Our work | admin, CC | categories.manage + content.publish | archiveDelete (0021) | sectors:all | 10 |
| client | clients | Our work | admin, CC | portfolio.write + content.publish | archiveDelete (0021) | clients:all | 10 |
| team_member | team_members | Collections | admin, CC | blog.write + content.publish | archiveDelete (0018) | team:all | 10 |
| statistic | statistics | Collections | admin, CC | services.write + content.publish | archiveDelete (0018) | statistics:all | 10 |
| certification | certifications | Collections | admin, CC | services.write + content.publish | archiveDelete (0018) | certifications:all | 10 |
| faq_item (FAQ slice) | faq_items | Collections | admin, CC | pages.write + content.publish | archiveDelete | faq:all | 10 |
| discipline | disciplines | Services | admin, CC | services.write + content.publish | archiveDelete (0028) | disciplines:all, services:all | 20 |
| service | services | Services | admin, CC | services.write + content.publish | archiveDelete (0001) | service:&lt;slug&gt;, services:all, + seo:sitemap/seo:llms on slug/status change | 30 |
| portfolio (+ children `portfolio_services`, `portfolio_media`) | portfolio | Our work | admin, CC | portfolio.write + content.publish | archiveDelete (0007) | portfolio:&lt;slug&gt;, portfolio:all, + sitemap/llms | 40 |
| service_case | service_cases | Services | admin, CC | services.write + content.publish | archiveDelete (0028) | service_cases:all | 50 |
| testimonial | testimonials | Our work | admin, CC | portfolio.write + content.publish | archiveDelete (0021) | testimonials:all | 60 |
| blog_post | blog_posts | Blog | admin, CC | blog.write + content.publish | archiveDelete (0001) | blog:&lt;slug&gt;, blog:all, + sitemap/llms | 70 |
| page | pages | Pages | admin, CC | pages.write + content.publish | archiveDelete (0007) | page:&lt;slug&gt;, + sitemap/llms | 80 |
| page_section | page_sections | Pages | admin, CC | pages.write + content.publish | archiveDelete (0007) | page:&lt;slug of page_id&gt; | 90 |
| nav_item | navigation | Navigation | admin, CC | nav.edit + content.publish | archiveDelete (0009) | nav:all | 100 |
| site_profile (singleton; every column except `accepting_applications`) | site_profile | Settings | admin, developer | settings.general | — | site:identity | 110 |
| custom_theme (+ activation) | custom_themes | Appearance | admin, developer | theme.edit | content.archiveDelete | theme:active (the Appearance slice adds it to ALWAYS; until then tenant:default) | 110 |
| site_chrome_* (Appearance slice singletons, one table per capability — Phase-3 amendment: a capability split through a row becomes a table) | … | Appearance | per table | theme.edit or settings.general | — | theme:active / site:identity | 110 |
| entity_seo | entity_seo | SEO | admin, seo | seo.entityMeta | — | the target's tag (service:/portfolio:/page:/blog:&lt;slug&gt;) | 120 |
| seo_defaults (singleton) | seo_defaults | SEO | admin, seo | seo.globalDefaults | — | tenant:default | 120 |
| redirect | redirects | SEO | admin, seo | redirects.manage | redirects.manage | none — KV `site:redirects` is rebuilt after the release | 130 |

- Creates and updates apply in ascending order; deletes apply in descending order.
- Self-references (`portfolio.next_portfolio_id`, `navigation.parent_id`) are listed as `deferred_columns` and set in a second pass.
- Unique flags (`navigation.is_key`) are cleared before they are set.
- Redirects are staged on purpose. `liveRouteRefusal` (resources.ts) refuses a rule whose source still answers a live page, so a slug rename and its 301 must be validated against the post-release route set and go live together. A rollback restores both.

### 1.2 Immediate — never staged

- **Maintenance mode + allowlist.** **I agree with the owner note.** It is the Pillar-1 kill switch, checked in the Worker before the cache lookup and read from KV (§3, §7).
  - Staging it would make taking the site down depend on a release passing validation of unrelated items.
  - §5 gives it to Developer, who must never publish content.
  - It stays an immediate, confirmed switch. It is also the emergency path for hiding content; page visibility is not.
  - Copy: "Maintenance mode is on. Visitors see the maintenance page now." (The mockup's "…after you publish" is wrong for us.)
- **Users and roles.** Demotion must take effect at once (§3 session invalidation).
- **Integrations and secrets, `ai_config`, technical `site_settings` keys** (retention, notify URL). None of these is public output. Connect/disconnect flows need immediate verification.
- **`site_profile.accepting_applications`.** An operational intake switch that `/api/apply` and `/api/apply/status` read live (no-store, not Tier A). It is Admin-only in both layers (0019 trigger + `guardWrite`). It moves to its own endpoint, `PATCH /api/admin/site-profile/intake`, and is an exempt column for the guard.
- **Leads, the CRM core (contacts, tasks, notes, pipeline), job applications.** Operational and PII data, never Tier A output. The marketing survey already established it "must not be wired to the savebar".
- **Media binaries (A5 uploads) and media metadata** (alt, tags, folder).
  - Anon cannot read an asset until published content references it (0024).
  - Referencing an asset is a staged change on the referencing row.
  - Alt and tags save immediately, as in the mockup, and purge `media:all`.
- **Style-Finder questions/styles.** The module is deferred (501 stub) and not on Tier A. These tables join the registry when the quiz ships.

### 1.3 Registry contract (CLAUDE.md §8 amendment)

A table may join the release registry only if:
1. every CMS role can already read it under RLS. Drafts and release items are readable by CMS staff, so a narrower table would leak through them.
2. its write policies and RESTRICTIVE gates already express who may author, publish, archive and delete it, because the apply binds to them.
3. it has `id` (or `tenant_id` for singletons), `tenant_id`, `version`, and the updated_at/actor/version triggers.
4. it gets the snapshot, capture and guard triggers in the same migration.
5. its TS registry entry maps it to tags and caps.
6. a table whose columns belong to two capabilities is split first.

---

## 2. Storage

### 2.1 Why one polymorphic draft table

- **Shadow tables** would double every column migration and every policy, and they would drift. Rejected.
- **`content_versions` with a draft kind** would make an append-only history mutable. Rejected.
- **One row per pending entity change** in one table is the choice. It mirrors the "single polymorphic `content_versions`" rule of §8.

### 2.2 `public.content_drafts`

```sql
create table public.content_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  entity_type text not null references app.release_entities (entity_type),
  entity_id uuid not null,            -- live PK; tenant_id for singletons; PRE-ALLOCATED for creates
  op text not null check (op in ('create','update','delete')),
  payload jsonb not null default '{}' -- merged camelCase input — UNTRUSTED, re-parsed by every consumer
    check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 524288),
  fields text[] not null default '{}' check (cardinality(fields) <= 200),   -- changed columns (display only)
  base jsonb not null default '{}' check (jsonb_typeof(base) = 'object'),   -- live values of patched columns when first patched
  base_version int,                   -- live version when the draft began (null for create)
  label jsonb check (label is null or jsonb_typeof(label) = 'object'),     -- {en, ar} for lists (display only)
  origin_kind text check (origin_kind in ('restore')),
  origin_release_id uuid references public.content_releases (id),
  release_id uuid references public.content_releases (id),                -- claimed by a scheduled release
  version int not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (tenant_id, entity_type, entity_id),
  constraint content_drafts_delete_shape check (op <> 'delete' or payload = '{}'::jsonb),
  constraint content_drafts_create_shape check (op <> 'create' or base_version is null)
);
-- + partial unique index: one pending entity_seo create per target
--   (tenant_id, payload->>'entityType', payload->>'entityId') where entity_type = 'entity_seo' and op = 'create'
-- indexes: (tenant_id, entity_type), (tenant_id, updated_by), (tenant_id, release_id) where release_id is not null
```

**RLS (ENABLE + FORCE; every predicate tenant-first, §3 Pillar 1):**
- **select:** `tenant_id = app.effective_tenant_id() and app.is_cms_staff()`
- **insert / update:** `tenant_id = app.effective_tenant_id() and app.can_author(entity_type) and (op <> 'delete' or app.can_stage_delete(entity_type)) and (payload->>'status' is distinct from 'archived' or app.is_admin()) and release_id is null`. The update policy's USING clause also requires `release_id is null`.
- **delete:** `… app.can_author(entity_type) and release_id is null`
- **Trigger `app.tg_draft_claim_lock`:** a staff JWT can never set or clear `release_id`. Claims are written only by the service-role schedule path.
- **Standard triggers:** updated_at, actor (`app.tg_set_actor`), version bump.
- **Grants:** `select, insert, update, delete` to authenticated; nothing to anon.

### 2.3 `public.content_releases` (the site versions)

```sql
create table public.content_releases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  number int check (number >= 1),                               -- assigned when it goes live
  kind text not null default 'publish' check (kind in ('baseline','publish','rollback','legacy_schedule')),
  status text not null check (status in ('applying','scheduled','published','failed','cancelled')),
  note text check (note is null or char_length(note) <= 280),
  scheduled_for timestamptz, scheduled_by uuid,
  published_at timestamptz, published_by uuid,
  restores_release_id uuid references public.content_releases (id),
  payload jsonb check (payload is null or jsonb_typeof(payload) = 'array'), -- scheduled: frozen, validated items
  item_count int not null default 0, areas text[] not null default '{}', tags text[] not null default '{}',
  purge_status text not null default 'pending'
    check (purge_status in ('pending','done','skipped','failed','not_needed')),
  purge_attempts int not null default 0, purge_next_at timestamptz, purged_at timestamptz,
  side_effects jsonb not null default '{}',                    -- {kvSynced, …}
  failure jsonb,                                               -- scheduled failures: {code, item, message}
  version int not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (tenant_id, number),
  constraint content_releases_numbered check ((status = 'published') = (number is not null)),
  constraint content_releases_schedule_shape check (status <> 'scheduled'
    or (scheduled_for is not null and scheduled_by is not null and payload is not null))
);
```

- **RLS select:** CMS staff, tenant-scoped.
- **No insert/update/delete policy and no write grant for authenticated.** Only `service_role` (inside `apply_release` and the purge/schedule RPCs) writes it, so staff cannot rewrite site history through PostgREST.

### 2.4 `public.content_release_items` (append-only)

```sql
create table public.content_release_items (
  id bigserial primary key,
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  release_id uuid not null references public.content_releases (id),
  entity_type text not null,           -- registry type, or 'portfolio_children'
  entity_id uuid not null,
  op text not null check (op in ('create','update','delete')),
  before jsonb, after jsonb,           -- full row images minus generated search_* columns
  draft_id uuid,                       -- null for cascades/side writes
  actor_id uuid, created_at timestamptz not null default now()
);
-- indexes: (tenant_id, release_id), (tenant_id, entity_type, entity_id, id desc)
```

- Select is allowed for CMS staff only.
- Only `app.tg_release_capture` writes it: a SECURITY DEFINER AFTER trigger, plus synthetic `portfolio_children` items from the apply.
- An insert policy `with check (app.release_token_valid())` exists only so the definer path works on an owner without BYPASSRLS — the same reasoning as 0009 gives for `content_versions`.
- authenticated holds no INSERT grant.
- §8 asks for `created_by`/`updated_by`. This is an append-only ledger like `audit_log`, so `actor_id` + `created_at` play that role.

### 2.5 `app.release_entities` (the registry, SQL side)

- Columns: `entity_type pk, table_name, key_column ('id'|'tenant_id'), area, author_roles text[], delete_roles text[], columns text[]` (the writable allowlist, including derived columns such as `body_html`, `reading_minutes`, `preview_*`), `deferred_columns, unique_flags, exempt_columns, apply_order, has_status, publish_flag`.
- It is global config with no `tenant_id`; the justification is the `app.deployment` precedent in 0016: it describes the schema, not a tenant.
- RLS ENABLE + FORCE with a select-only policy. Select is granted to authenticated and service_role. Writes are revoked from everyone; only migrations change it.

### 2.6 `content_versions` changes

- `add column release_id uuid references public.content_releases (id)` + index. `app.tg_snapshot_version()` is recreated to set `release_id` from the GUC `app.release_id` when `app.release_token_valid()`.
- **Coverage gaps closed.** Today snapshots exist only on services, blog_posts, portfolio, pages (0009), page_sections (0016), sectors, clients, testimonials (0021), disciplines and service_cases (0028).
  - New `<table>_snapshot` triggers on team_members, certifications, statistics, categories, navigation, redirects, entity_seo and custom_themes.
  - New `app.tg_snapshot_singleton(entity)` (entity_id = tenant_id) on site_profile and seo_defaults.
  - Born with them: faq_items and the site_chrome tables.
  - Portfolio children stay out of `content_versions`; the ledger carries them as `portfolio_children` items.
- **Hardening.** `revoke insert on public.content_versions from authenticated`; the definer trigger is the only writer. Today 0011 §5d grants staff INSERT, so any staff member can forge history rows through PostgREST. `content_versions_read` moves to `app.is_cms_staff()` so Sales stays out.

### 2.7 Helpers (schema `app`, 0011 default-deny respected)

- `app.is_cms_staff()`: the role is in (admin, content_creator, seo, developer). This is an explicit list, not `is_staff()`, so the Sales slice cannot widen it by accident.
- `app.can_author(text)` and `app.can_stage_delete(text)` read `author_roles` / `delete_roles` from the registry. They are invoker functions granted to authenticated, because the drafts policies evaluate them. Anon never reads these tables, so no anon grant.
- `app.release_token_valid()`: `coalesce(current_setting('app.release_apply', true), '') = txid_current()::text`. Only `apply_release` sets this GUC. A PostgREST request is one transaction and no exposed function sets it, so no client can combine the token with a write.
- `app.releases_enabled(uuid)`: definer; reads `site_settings.releases_enabled` (new boolean column, default false, changed only by the runbook functions).
- Trigger functions `app.tg_release_guard()`, `app.tg_release_capture()`, `app.tg_snapshot_singleton()`, `app.tg_draft_claim_lock()`: definer, revoked from every API role (0011 §6c).
- The `supabase/tests/grants_app_schema.test.sql` allowlist gains the three granted helpers.

### 2.8 How each change is represented

| change | op | payload / effect |
|---|---|---|
| never-published row (create) | `create` | Full create payload. `entity_id` is pre-allocated (`crypto.randomUUID()`), so other drafts can link to it. No live row exists until a release applies it. Its `status` (default `draft`) decides whether it goes live or arrives hidden. |
| edit of an existing row | `update` | Cumulative payload. `base` records the live values of each newly patched column. A save that makes the patch equal to live deletes the draft (nothing pending). |
| status flip (publish / unpublish) | `update` | `status` in the payload. `published_at` is stamped **at apply** (first publish only; never rewritten — truthful dates, §3 Pillar 3). `publishStamp` in `toRow` is disabled in staged mode. |
| archive | `update` | `status: 'archived'`. Staging it requires `content.archiveDelete` (Worker + drafts RLS); at apply the RESTRICTIVE archive policies bind. |
| visible flip (sections, clients, sectors, nav) | `update` | `visible` in the payload; visible → true is a go-live (`content.publish` + `assertPublishable`). |
| reorder | `update` per row | `sortOrder` only. The UI groups these as one logical change ("New order: Services"). |
| delete | `delete` | Empty payload. Needs `content.archiveDelete` (redirects: `redirects.manage`) at stage time and the RESTRICTIVE delete policy at apply. Deleting a pending create = discarding it. |
| portfolio child sets | on the parent's draft | `serviceIds` / `media` in the payload (replaced as a whole set, as `save_portfolio` does). |
| singletons | `create`/`update` | `entity_id = tenant_id`; a create merges `config.defaults` (as `singleton.ts` does today). |
| entity_seo | `create`/`update` | `entity_id` = the entity_seo row id (pre-allocated); the target (`entityType`, `entityId`) is fixed at create. |
| per-item schedule | — | Refused (422: "Schedule the release instead"). `scheduledFor` is ignored in staged mode. |

---

## 3. Write path — `resource.ts`, `crud.ts`, `singleton.ts`

- `defineAdminRoute` (`src/lib/admin/route.ts`): the handler context gains `releasesEnabled(): Promise<boolean>`. It is memoized per request in locals and read from `site_settings` with the RLS client. Everything else in the kernel is unchanged (assertCap/anyCap, Zod, audit, no-store, error mapping).
- `src/lib/admin/resources.ts`:
  - Each `ResourceConfig` gains an introspectable `fields` map (payload key → column(s), derived columns included: `clip` → `preview_*`, `body` → `body`, `body_html`, `reading_minutes`). `toRow` is rebuilt on top of it and the map is used for diffs, conflict display and "use live".
  - `assertWritable`/`assertPublishable` receive `ctx.db: OverlayDb` (`exists(table, id)`, `get(table, id, cols)`, `list(table, filter)`) instead of querying `ctx.sb` directly. Links can then point at pending creates in the same release, and redirect checks see the post-release route set.
  - Affected functions: `assertLinkInTenant`, the portfolio poster-alt check, `chainRefusal` reads, `liveRouteRefusal` in `src/lib/admin/redirectRules.ts`.
- `src/lib/admin/resource.ts` — staged branch when the entity is in the registry and `releasesEnabled()`; the legacy branch stays untouched until the contract slice:
  - **POST** (create): `createSchema.parse` (as now) → `toRow` (validation only) → `assertWritable` over the overlay. Upserts an `op='create'` draft with a pre-allocated id. Returns the synthesized row, `version: 0` and `draft` meta.
  - **PATCH**: input = `updateSchema` + optional `draftVersion`.
    - With an existing draft: require `draftVersion === draft.version`, otherwise 409 `draft-conflict`.
    - Without one: require `version === live.version`, otherwise 409 `conflict` (as today), and record `base`/`base_version`.
    - If the client sent a `draftVersion` for a draft that a release has since consumed: 409 `draft-published` with the new live row. The form keeps the user's typed values and offers "Save again".
    - If the draft is claimed by a scheduled release: 409 `scheduled`.
    - Then merge the payload, re-derive the patch, drop columns equal to both live and base (an empty patch deletes the draft), run `assertWritable` on live ⊕ patch, and refuse `status:'scheduled'`. `assertStatusTransition` and the `visible`-as-publish check run at stage time exactly as now.
  - **DELETE**: stage `op='delete'` (`deleteCap` + write cap, as today), or discard a pending create.
  - **reorderRoute**: one `sortOrder` draft per moved row (max 200, as now).
  - **GET item**: live (`getRowOrNull`, new in `crud.ts`) ⊕ draft. Returns `version` = live version (0 for a pending create) and `draft: {id, version, op, fields, updatedBy, updatedAt, releaseId, conflict?}`.
  - **GET list**: the live page plus the entity type's drafts (one indexed query, ≤ 1,000), overlaid with `src/lib/release/overlay.ts`. Pending creates that match the filters/search are evaluated on derived values. Rows are re-sorted. Pending deletes stay listed with a badge. Total = live total + matching creates.
- `src/lib/admin/singleton.ts`: same pattern keyed by `tenant_id`, with `guardWrite` still running. New `immediateColumns` option: `site_profile` declares `accepting_applications`, served only by `PATCH /api/admin/site-profile/intake` (Admin; `guardWrite` + 0019 trigger; guard-exempt column).
- `src/pages/api/admin/entity-seo.ts` GET/PUT is staged in the same way, keyed by target.
- Portfolio: the payload keeps `serviceIds`/`media`. `persist`/`save_portfolio` are no longer called in staged mode.
- Theme activation: staged `isActive` updates; the apply deactivates the others in the same transaction (today this is a non-atomic `afterWrite`).
- `src/lib/release/drafts.ts`: `saveDraft`, `discardDraft`, `rebaseDraft`, `dropFields`.
- Audit: `<entity>.draft_save` (field names only, never values — `audit.ts` rule), `<entity>.draft_discard`, `drafts.discard_bulk`.
- **Draft endpoints:**
  - `GET /api/admin/releases/pending` — items the caller can read, with `publishableByMe`, `requiredCaps`, `waitingFor` (roles, from `ROLE_CAPS`) and counts by area.
  - `DELETE /api/admin/drafts/[id]?version=`
  - `POST /api/admin/drafts/discard` — `{scope:'mine'}` or `{ids, versions}`.
  - `POST /api/admin/drafts/[id]/resolve` — `{version, keepMine: column[], useLive: column[]}`.
  - All are cap-bounded per item by the entity's write cap and RLS `can_author`.
- **Admin read surfaces that must overlay:** resource lists/items/pickers (relation fields load from the collection GET), singletons, entity-seo, `media_usage` (§4.4), dashboard counts. Global search stays live-only in v1 (a pending create is found through its list).

---

## 4. Publish

### 4.1 Who may publish what (derived from ROLE_CAPS — no new capability)

`requiredCaps(item)`:
- the area's caps from §1.1;
- plus `content.archiveDelete` when op = delete or the status goes to archived (redirects: `redirects.manage`);
- a content-area item needs its write cap **and** `content.publish`.

Release publish matrix (doc table under §5, proven against `ROLE_CAPS` by `tests/authz/releaseMatrix.spec.ts`):

| Release area | Admin | Content Creator | SEO | Developer |
|---|:-:|:-:|:-:|:-:|
| Content (pages, sections, services, disciplines, cases, Our work, collections, blog, navigation) | ✅ | ✅ | ❌ | ❌ |
| Content removals and archives | ✅ | ❌ | ❌ | ❌ |
| Public identity | ✅ | ❌ | ❌ | ✅ |
| Theme and appearance | ✅ | ❌ | ❌ | ✅ |
| Per-entity SEO / global SEO defaults / redirects | ✅ | ❌ | ✅ | ❌ |

Sales, anon and other_tenant: ❌ on every row. Each cell equals what the role can make live today by saving, so nobody gains power.

### 4.2 `POST /api/admin/releases` — publish now

Kernel: `cap 'content.publish'` (the label), `anyCap` = [content.publish, theme.edit, settings.general, seo.entityMeta, seo.globalDefaults, redirects.manage]. Body (`packages/schemas/release.ts` `PublishRequestSchema`): `{ items: [{draftId, draftVersion}] (1..500), note? (≤280, no control characters), scheduleAt? (R11), kind: 'publish'|'rollback' }`.

1. Load the drafts with the RLS client. Any missing draft, or a version mismatch: 409 `pending-changed`.
2. Run `assertCap` for every required cap of every item (403 names the item and the role that could publish it).
3. Run `liveRecheck(auth)` (`src/lib/admin/liveRecheck.ts`).
4. **Validate on the post-release state.** Build the overlay of live rows plus the selected drafts. For each item:
   - re-parse the payload (`createSchema`/`updateSchema` + `toRow`) to get the authoritative column patch and children;
   - `assertWritable(merged, {db: overlay})`;
   - when `isLive(merged)`: `assertPublishable(merged, …)`. This covers `requireBilingual` (EN+AR), `refusePlaceholder` + `refusePlaceholderFigures`, the testimonial consent rule, E-E-A-T author, bilingual poster alt, discipline required, section content per type, and the sample-rating guard.
5. **Cross-item checks:**
   - dependencies: an FK to a pending create that is not selected → 422 with `requires: [draftId]` (the UI auto-adds it);
   - deleting a parent with selected child changes;
   - redirect chain and live-route rules against post-release routes;
   - warnings (do not block): "Logo Design will stay hidden: its discipline is not published"; nav href to an unpublished page.
6. Call `serviceClient().rpc('apply_release', { p_actor: auth.userId, p_role: auth.role, p_mode: 'publish', p_items, p_note, p_kind })`. Each item is `{draft_id, draft_version, entity_type, entity_id, op, patch, children, base}`.
7. **After commit — never fatal** (the `runHook` contract in resource.ts):
   - compute tags from the returned items (`src/lib/release/tags.ts`) and purge (§5);
   - `syncRedirectsToEdge` when redirects changed;
   - record the outcome with `record_release_purge`;
   - kernel audit `release.purge`.
8. Response: `{ release: {id, number}, items, purge: 'done'|'pending'|'skipped'|'failed', kvSynced? }`.

### 4.3 `POST /api/admin/releases/validate` — dry run

Steps 1–5, then `apply_release(p_mode := 'dry_run')`. Returns the per-item report: errors (field-mapped through `constraintFields`/`writeRefusals`), warnings, conflicts, dependencies. This is how the publish dialog shows real DB outcomes (CHECKs, guard triggers, RESTRICTIVE policies) before anyone presses Publish.

### 4.4 `public.apply_release` (migration R4) — algorithm

```text
apply_release(p_actor uuid, p_role text, p_mode text /* publish|dry_run|schedule|fire */, p_items jsonb,
              p_note text, p_kind text, p_release_id uuid, p_scheduled_for timestamptz) returns jsonb
  language plpgsql security invoker set search_path = public, app, pg_temp set statement_timeout = '20s'
 0. require current_user in ('service_role','postgres'); EXECUTE revoked from public/anon/authenticated (postcondition)
 1. live actor: profiles row with is_active, unlocked, role = p_role, role in CMS roles, tenant = item tenants → else BR403
 2. pg_advisory_xact_lock(hashtextextended('release:'||tenant, 0))   -- serialises releases per tenant
 3. as service_role:
    - insert content_releases (status 'applying'), or for 'fire' flip a due 'scheduled' row to 'applying' (no row → {skipped})
    - lock the drafts FOR UPDATE; ids/versions must match p_items → else BR409 'pending-changed'
    - 'schedule': store p_items as payload, status 'scheduled', claim the drafts, audit, return
 4. set_config('app.release_id', id, true); set_config('app.release_apply', txid_current()::text, true)
    set_config('request.jwt.claims', {sub, role:'authenticated', app_metadata:{role, tenant_id}}, true)
      (+ request.jwt.claim.sub for auth.uid())
    SET LOCAL ROLE authenticated
    -- from here every write is the publisher's: RLS, RESTRICTIVE gates, CHECKs, 0019/0025/0028 triggers bind
 5. per item, ordered (registry order; deletes reversed; unique flags cleared first), each in its own BEGIN…EXCEPTION
    block collecting {draft_id, sqlstate, constraint, message}:
    - patch keys ⊄ app.release_entities.columns → raise 22023 naming the column (loud drift, never silent)
    - update: lock the live row; typed three-way check per patched column
        (jsonb_populate_record(null::t, {col: live}) vs (…{col: base}) IS DISTINCT FROM — immune to '12.50' vs 12.5)
        → conflicts list; published_at rule; dynamic UPDATE via format('%I') identifiers + USING values;
        0 rows → 42501 (RLS refused)
    - create: INSERT (id from the draft) with only the patch columns, so table defaults apply
    - delete: DELETE; 0 rows → 42501 (RESTRICTIVE delete)
    - portfolio children: app.apply_portfolio_children() (extracted from save_portfolio, which keeps its signature)
      + a synthetic 'portfolio_children' item {before:{service_ids,media}, after:{…}}
    - custom_theme isActive=true → deactivate the others in the same transaction
 6. second pass: deferred self-reference columns
 7. SET LOCAL ROLE service_role: delete the consumed drafts; finalise the release
    (number = max+1 under the lock, status 'published', published_at/by, item_count, areas);
    insert audit_log 'release.publish' {release_id, number, kind, item_count, items:[{type,id,op}] ≤200}
    — atomic: no release without its audit row (the chain trigger computes the hash, §3)
 8. conflicts → raise 'BR409' (detail = JSON list); errors → 'BR422' (detail = JSON) → the whole transaction rolls back
 9. dry_run: steps 3–8 run inside a block that ends with raise 'BRDRY', caught → report returned, nothing persists, no number used
10. return {release_id, number, items: content_release_items rows of this release}
```

- Capture: `app.tg_release_capture(entity_type, key_column)` runs AFTER INSERT/UPDATE/DELETE on every registry table and writes an item whenever the token is valid. It therefore also records RI cascades and set-nulls: service delete → its `service_cases`; page delete → its sections; team member delete → `blog_posts.author_id`; theme deactivations.
- The Worker turns `BR403`/`BR409`/`BR422` into 403/409/422 with item and field detail.
- **Risk to verify on staging:** the role switching needs the PostgREST session user (`authenticator`) to be a member of `authenticated` and `service_role`, which is the Supabase default. pgTAP exercises it locally.
- Fallback, documented but not preferred: a SECURITY DEFINER apply with explicit SQL re-checks of the RESTRICTIVE rules.

### 4.5 Conflicts

- **Between editors on one pending change:** `draftVersion` mismatch → 409 `draft-conflict` (reload; same as today's `conflict`).
- **Live moved under a pending change** (runbook SQL edits, legacy rows during transition, an immediate exempt column — exempt columns are never in a patch so they never conflict, or a release that deleted the row):
  - `BR409` lists `{draftId, columns, live, base, mine}`.
  - "Keep mine" → `resolve` sets `base[col] = live[col]`.
  - "Use the live version" → removes the column from the payload (an empty patch discards the draft).
  - A row deleted under the draft → "This item was removed on the live site" → Discard.
- **Concurrent publishers:** the advisory lock serialises them. The second publisher gets 409 `pending-changed` for drafts the first one consumed, and the dialog refreshes.

### 4.6 Ledger, audit, observability (DoD-6)

- **Audit:**
  - `release.publish` is written inside the RPC.
  - The kernel adds `release.purge`, `release.schedule|reschedule|unschedule|fail|restore`, `<entity>.draft_save|draft_discard`.
  - Detail carries ids, field names and counts — never values.
- **`system_logs`:**
  - `release:purge` — info once per skipped release; error on exhausted retries.
  - `cron:releases` — fire failures and overdue releases.
  - `admin:<entity>.release` — post-apply hook failures.
- **`dashboard_attention` v4** (derived view, §8): `release_scheduled_today`, `release_overdue` (> 5 min late), `release_failed`, `purge_failed`, `draft_stale` (> 30 days).
- **Backups:** `content_drafts`, `content_releases`, `content_release_items` join `BACKUP_TABLES` (`src/lib/admin/backupTables.ts`). They hold content only; leads never appear in versions or backups (§7).

### 4.7 Scheduled releases (R11)

- **Schedule:** the same request with `scheduleAt` (at least 2 minutes ahead, at most 366 days; shown and entered as Riyadh time). It runs steps 1–5 of §4.2, then `apply_release(p_mode:'schedule')` stores the validated items on the release and claims the drafts. A claimed draft is read-only: edits and discards answer 409 `scheduled` until the release is unscheduled.
- **Fire:** the Worker's **minute** cron (`wrangler.jsonc` adds `"* * * * *"`; `src/worker.ts` `scheduled` dispatches on `controller.cron`; `src/lib/cron/releases.ts`):
  - selects due releases with the service client;
  - re-checks `requiredCaps` against the scheduler's **live** role;
  - calls `apply_release(p_mode:'fire', p_actor: scheduled_by)` — the same path, so RLS binds as the scheduler;
  - purges and syncs KV;
  - a second run finds the release no longer `scheduled` (idempotent).
- **Failure** (demoted or inactive scheduler, conflict, validation): status `failed` with `failure`, claims released, `system_logs` error, attention row. It fails closed.
- **Publish now** on a scheduled release = unschedule + publish with fresh validation. **Reschedule / unschedule:** `PATCH` / `DELETE /api/admin/releases/[id]` (version-checked; caller must hold the caps for all items, or be Admin).
- **Legacy migration** (runbook function `app.enable_releases(tenant, operator, fallback_scheduler)`, revoked from API roles):
  - for each release-managed row with `status = 'scheduled'`, create an `update` draft `{status:'published'}`;
  - group them by `scheduled_for` into scheduled releases (`kind 'legacy_schedule'`, `scheduled_by = coalesce(updated_by, fallback_scheduler)`);
  - set the live status from `scheduled` to `draft` (as postgres — no role claim, so the guard does not apply);
  - write baseline release v1;
  - set `releases_enabled`.
  - `app.publish_scheduled()` is recreated to skip enabled tenants. The `publish-scheduled` pg_cron job keeps running for non-enabled tenants until the contract slice.

### 4.8 Discard (cap-bounded)

- **One item:** `DELETE /api/admin/drafts/[id]` (entity write cap + RLS `can_author`). A pending create disappears; a pending delete is undone ("Undo removal").
- **"Discard my changes":** drafts whose `updated_by` is the caller, unclaimed.
- **"Discard selected":** from the dialog; the confirm names other authors' items.
- No undo after confirm. The audit keeps field names only.

---

## 5. Cache — the purge seam

### 5.1 Tag set of a release (`src/lib/release/tags.ts`)

- The union over items of `registry.tags(before)` ∪ `registry.tags(after)`, using the vocabulary the routes already stamp (`src/lib/http/cacheTags.ts` and the route entity lists). A slug change therefore purges the old URL's page too.
- `page_section` items resolve `page:<slug>` through `page_id`.
- URL-bearing changes add `seo:sitemap`, `seo:llms`: create/delete/status/slug of pages, services, disciplines, portfolio and blog.
- Count ≤ 30 → purge those tags; > 30 → purge `['tenant:default']`.
- Empty → `not_needed` (redirect-only releases update KV instead).

### 5.2 Page tags must cover what a page actually renders

- Editors can add table-backed sections (statistics, team, leadership, testimonials, clientsMarquee, certifications, faq…) to any composed page.
- Static route lists therefore miss tables. Example: About stamps `page:about, team:all, statistics:all` but no `certifications:all` and no `testimonials:all`.
- New `src/lib/sections/reads.ts` `SECTION_READS: Record<SectionType, CacheTag[]>`. Every Tier A route calls `setTierA(…, entities: [...routeTags, ...sectionTags(sections)])`.
- New tags: `certifications:all`, `faq:all`, `theme:active` (Appearance), `seo:sitemap`, `seo:llms`.
- `sitemap.xml.ts` / `llms.txt.ts` stamp `tenant:default, seo:*` (still `max-age=3600` until the zone; then long `s-maxage` + purge, closing their `TODO(KAN-20)`).

### 5.3 `src/lib/http/purge.ts` — the one module that talks to Cloudflare

- `purgeTags(tags, {releaseId}) → {status: 'done'|'skipped'|'failed', tags, attempts, detail}`. It never throws.
- Config:
  - `CF_ZONE_ID`: `envField.string({context:'server', access:'public', optional:true})`.
  - `CF_CACHE_PURGE_TOKEN`: `envField.string({context:'server', access:'secret', optional:true})`, a Zone · Cache Purge token for this zone only, added to `scripts/push-secrets.mjs` (§3 secrets via astro:env).
  - Absent → `skipped`, with one info `system_logs` row per release: "no zone (KAN-20)".
- Call: `POST https://api.cloudflare.com/client/v4/zones/{zone}/purge_cache {tags}`.
  - Retries with backoff + full jitter (3 tries within the request; 2.5 s budget on the publish request).
  - Isolate-local breaker.
  - Purge is idempotent (§3 Pillar 4: backoff + jitter + breaker + idempotency).
- 429/5xx → `failed` with `purge_next_at`. The minute cron retries (exponential, up to 10 attempts), merging pending releases' tags into ≤30-tag calls or `tenant:default`. This respects the Free plan's 5 purge requests/min.
- Media metadata saves (immediate) purge `media:all` through the same module.
- **Pre-zone truth:** on `*.workers.dev` no layer stores Tier A responses, so `skipped` still means "the website now shows these changes".
- The future Tier A cache layer (R43/KAN-20; Workers Cache API on the custom domain, whose entries are purgeable by `Cache-Tag`) must store only `public, s-maxage` 200s. Preview and every `/admin/**` response are `private, no-store` and carry no `Cache-Tag` (§6.3).

### 5.4 KV-backed state

- Redirect releases → `syncRedirectsToEdge` (`src/lib/admin/redirectSync.ts`) after commit. The interactive path uses the publisher's RLS client.
- The cron fire path uses the service client scoped to the release's tenant. This is a documented system-actor exception, like the daily cron.
- The 60 s isolate TTL still applies.
- Maintenance KV is untouched (immediate).

---

## 6. Versions, history, rollback, preview

### 6.1 Versions (site level)

- `GET /api/admin/releases` lists published releases (number desc), with scheduled and failed ones on top.
- `GET /api/admin/releases/[id]` returns items filtered by the caller's read caps (registry → `readCaps`), with field-level before/after for scalar and bilingual fields and "changed" for rich text.
- Gate: CMS staff via `anyCap` over the author/publish caps; Sales 403.
- The baseline v1 is written at switch-on, so "Restore v1" means "as it was when releases began".

### 6.2 Per-item history and rollback

- **History** (`GET /api/admin/history?entityType&entityId`): `content_versions` rows (version, at, by, `release_id` → number), plus the pending draft if any.
- Names come from a `staff_directory` view (`id, display_name`, CMS staff). `profiles` is admin-read-only today, and the dashboard slice needs the same view.
- **Restore vN** (`POST /api/admin/releases/[id]/restore`): `src/lib/release/revert.ts` computes the as-of-vN state. For every entity touched by releases numbered > N, the `before` of the earliest such item is its state at vN; a null `before` means it did not exist then. The endpoint then stages drafts:
  - `update` with the allowlisted columns that differ from live;
  - `create` with the same id for entities deleted since;
  - `delete` for entities created since;
  - portfolio children from `portfolio_children` items.
  - `origin_kind 'restore'`.
  - It refuses (listing them) when any of those entities already has a pending change, or when the caller lacks the caps for any area involved ("Ask an Admin: this version includes Theme and SEO changes").
- Publishing those drafts creates `kind 'rollback'`, `restores_release_id`, default note "Restored vN".
- **Per-item restore** (`POST /api/admin/history/restore`): stages the chosen snapshot's allowlisted columns.
- Restores are validated like any publish: hard-deleted media, reused slugs and placeholders are reported, never forced.

### 6.3 Preview (Tier C) — architecture

1. **Data seam** (`src/lib/data/source.ts`): `contentClient()` returns the AsyncLocalStorage store's client, or else `anonClient()`.
   - Every public loader switches `anonClient()` → `contentClient()` (15 files). A test forbids `anonClient()` anywhere else.
   - A public request never enters a store, so Tier A behaviour, performance and RLS posture are unchanged.
   - `nodejs_compat` is already on (`wrangler.jsonc`).
2. **Overlay client** (`src/lib/preview/client.ts`): an in-memory emulator of the PostgREST subset the loaders use:
   - `from().select()` with aliased and nested embeds (`poster:poster_media_id(...)`, `services:portfolio_services(sort_order,service:service_id(...))`);
   - `eq/neq/in/is/contains/order/limit/range/maybeSingle/single`;
   - `rpc()` → "not previewable" (search);
   - unknown methods throw in test builds.
   - `relations.ts` maps FK columns and child tables.
3. **Dataset** (`src/lib/preview/dataset.ts`):
   - live rows of the tables a route reads, all statuses, through the staff session client (`locals.supabase`), capped at 2,000 rows/table and memoized per request;
   - ⊕ pending drafts in areas the caller can read (registry `readCaps`), each re-parsed through Zod + `toRow` — invalid drafts are not overlaid and the ribbon lists them;
   - mode `?v=<n>` uses the as-of overlay instead (§6.2);
   - `?only=<draftIds>` previews a dialog selection.
4. **Visibility** (`src/lib/preview/visibility.ts`): a TS mirror of anon RLS, applied to top-level and embedded rows. Each rule is commented with its migration:
   - status published (pages, services, disciplines, portfolio, testimonials, team, statistics, certifications, blog);
   - visible (clients, sectors, navigation);
   - `services_discipline_published`;
   - published-parent fences (`service_cases`, `portfolio_services`/`portfolio_media`, `page_sections` visible + page published);
   - `entity_seo` parent published;
   - the `media_assets_public_read` predicate (hosted provider + referenced by visible content, section `mediaId`s included).
   - If the mirror drifts, only preview fidelity suffers — staff can already read everything — and the parity e2e catches it.
5. **Route** `src/pages/admin/preview/[...path].astro` (`prerender = false`) + `src/lib/preview/routes.ts`:
   - maps every Tier A path (EN and `/ar/`) to its loader and view;
   - every public page is refactored into a `load*` function plus a view component (`HomePage`, `AboutPage`, `ServicesPage`, `ServicePage`, `CatalogPage`, `CaseStudyPage`, `ContactPage`, `JoinPage`, blog, legal); the public pages become thin;
   - unknown paths → a preview 404;
   - `/search` shows "Search results aren't previewed".
6. **Middleware** (`src/middleware.ts`), for `/admin/preview/` after the auth gate:
   - `assertAnyCap` (CMS read caps; Sales → 403);
   - build the overlay source;
   - `const res = await withContentSource(src, async () => { const r = await next(); return new Response(await r.text(), r); })`. Buffering inside the scope keeps AsyncLocalStorage through Astro's streaming render (the dev branch already buffers). Fallback if workerd loses the context: thread `locals.contentSource`.
   - For every private response: `Cache-Control: private, no-store` (exists) + delete `Cache-Tag` + `X-Robots-Tag: noindex, nofollow`.
7. **BaseLayout preview mode** (`Astro.locals.preview` set by middleware):
   - no `ConsentBanner`, `WebVitals`, `PageView`, `ErrorReporter` — previews never emit telemetry or consent;
   - robots `noindex,nofollow`;
   - a server-rendered ribbon ("Preview · not live · N unpublished changes" / "Preview of vN · date"; link back; language twin);
   - `preview.css` (added to the closed stylesheet union);
   - `SectionRenderer` emits `data-pv-section="<id>"` (`toSection` keeps the id; emitted only in preview);
   - the bridge script.
8. **CSP:** `buildCsp(nonce, {frameSelf})` adds `'self'` to `frame-src` only for `/admin/**` responses, where the editor frames `/admin/preview`. Public responses keep no same-origin framing. `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` already allow the preview to be framed. Changed at the one enforcement point (§3, §7).
9. **Bridge** (`src/scripts/previewBridge.ts`, built as an `admin-*` chunk so it counts against the admin budget only; parent side `src/lib/admin/previewChannel.ts`).
   - **Envelope:** `packages/schemas/previewMessage.ts` (Zod discriminated union `v:1`):
     - parent→preview: `jump{sectionId}`, `highlight{sectionId|null}`, `scroll{y}`, `reload`, `tokens{Record<'--bs-*', value>}` (validated by `ThemeTokensSchema`, applied with `style.setProperty` — "tokens as CSS custom properties only");
     - preview→parent: `ready{path, locale, sections:[{id, anchor}]}`, `scroll{y}`, `navigate{path}`.
   - **Checks:** `postMessage(msg, location.origin)`. Receivers require `event.origin === location.origin`, and `event.source === iframe.contentWindow` (parent) or `window.parent` (preview). Invalid envelopes are dropped.
   - **In-preview behaviour:** same-origin link clicks are rewritten into `/admin/preview/<path>` and reported to the parent; form submits are blocked ("Forms don't send in preview").
   - **Refresh:** the editor autosaves the draft about 800 ms after typing stops, then reloads the iframe and restores the scroll position. This is a real server render, not DOM patching.
10. **Budgets:** no public JS change (asserted: public HTML never references the bridge). New admin islands and the bridge facade are added to both `.size-limit.json` lists (§2 admin bundle amendment). Estimate ≤ +18 KB gz, no new dependencies.

---

## 7. UX contract (for the UI architect)

**Savebar** — fixed bottom-centre midnight pill, as in the mockup.
- **When shown:** for CMS roles with ≥ 1 pending item they can read. Never on login, never for Sales.
- **Content:**
  - Amber dot plus "You have {n} unpublished change(s)", where n = items the viewer may publish (reorders of one list count once).
  - If n = 0: "{m} unpublished change(s) waiting for someone who can publish them".
  - Secondary line: "{a} in Pages · {b} in Services …", plus "+{m} waiting for someone who can publish" when both n and m are non-zero.
- **Buttons:**
  - [Discard ▾] (ghost) with "Discard my changes ({k})" and "Choose…".
  - [Preview] (ghost; opens `/admin/preview/` in a new tab).
  - [Publish] (primary; hidden when n = 0).
- **Behaviour and accessibility:**
  - `role="region"` with `aria-label="Unpublished changes"`; a polite live region announces debounced count changes.
  - Pages get `scroll-padding-bottom` so the bar never hides focus (WCAG 2.4.11).
  - Reduced motion: no slide-in.
  - Styling through classes and `data-*` attributes only (CSP).

**Publish dialog** — native `<dialog>`; the same dialog opens from the savebar, the page editor's Publish (scrolled to and highlighting that page's items) and the dashboard.
- **Header:** title "Publish to the website". Sub: "Everything ticked goes live together."
- **Item list**, grouped by area. Each row has:
  - a checkbox, checked by default when publishable by the viewer;
  - the label;
  - a change badge: New / Changed / Published / Hidden / Shown / Archived / Removed / Restored / Reordered;
  - the changed fields ("Title, Intro, +2"), the author and a relative time;
  - the dry-run status: ✓ Ready · ⚠ warning · ✕ error with "Fix" (opens the editor) · "Conflict".
- **Dependencies** are ticked automatically with a note "Included because 'X' needs it". Unticking one unticks its dependants.
- **"Waiting for someone who can publish":** disabled rows with "needs an Admin" / "needs an Admin or a Developer" (computed from `ROLE_CAPS`; UX only).
- **Fields:**
  - "Note (optional) — shown in Versions" (≤ 280).
  - "When": Now | Schedule for [date] [time] "Riyadh time".
- **Footer:** [Cancel] [Preview selection] [Publish {n} changes] / [Schedule {n} changes].
- **Results:**
  - success (purge done or skipped): toast "Published v{N}. The website now shows these changes."
  - purge pending/failed: "Published v{N}. Some pages may show the old version for a few minutes." / "…couldn't refresh the website cache — Retry".
  - scheduled: "Scheduled for {date time} (Riyadh). These changes are locked until then."
  - 403: "Your role can't publish {item}. Ask an Admin."
  - 409 / 422: shown inline on the rows, never as a toast (toasts are success-only).

**Conflicts** — on the row: "Changed on the live site since this edit started ({name}, {time}): {fields}". Actions: [Keep my version] [Use the live version] [Compare] (a drawer with field | live | yours, EN and AR).

**Per-item badges** — in lists and editor headers, next to the live status badge ("Published · Unpublished changes"):
- "Unpublished changes";
- "New · not live yet";
- "Will be removed" (editor read-only + "Undo removal");
- "Scheduled {date}" (read-only + "Unschedule to edit", when allowed);
- "Changed on the live site" (conflict).

**Forms in release mode:**
- The per-item "Schedule" field disappears.
- The status select becomes a "Visible on the site" toggle (+ Archived for Admin).
- Saving keeps the user's values on 409 and offers "Save again".
- Autosave interval ≥ 30 s for long forms; the page editor saves on blur and after an 800 ms idle.

**Discard confirms:**
- One item — "Discard this change?" / "Your unpublished changes to {label} will be thrown away. The live site doesn't change." / [Discard].
- Mine — "Discard your unpublished changes?" / "{k} changes you made since the last publish will be thrown away. The live site doesn't change."
- Selection with others' items — "Discard {k} changes?" / "This includes {j} changes by {names}. They will be lost. The live site doesn't change. This can't be undone."

**Dashboard "Publish status" card** (`GET /api/admin/releases/status`):
- "Live version v{N}" plus "Published {ago} by {name}" (+ note);
- "Unpublished changes: {n} yours to publish · {m} waiting" (badge Yes/None);
- "Next scheduled: {date} · {k} changes" [Manage];
- "Website cache: Up to date | Refreshing… | Not connected yet | Couldn't refresh [Retry]";
- "Maintenance: On/Off";
- [Publish now] (when n > 0) · "Versions →".

**History drawer** (every editor) — title "History: {label}", sub "Every published version of this item".
- Pending row on top: "Unpublished changes · {name} · {ago}" [Preview] [Discard].
- Then rows "v{k} · live now" / "v{k} · in release v{N}", note, "by {name} · {date time}".
- Older rows: [Preview] [Restore].
- Empty state: "No history yet".

**Versions page** (Settings › Backups & versions; CMS roles):
- Card "Versions": "{N} published versions"; timeline "v{N} · live now", note, by · date time, "{k} changes in {areas}"; older entries: [Preview] [Restore] [Details].
- Scheduled releases on top: "Scheduled · {date}" [Change time] [Unschedule].
- Failed releases: "Couldn't publish on {date}: {reason}" [Review].
- Restore confirm: "Restore v{N}?" / "This version's content comes back as unpublished changes for you to review. Nothing goes live until you publish, and the current version stays in the list." Toast (mockup copy): "v{N} restored. Publish to make it live."
- The Backups card shows only "Download content" (export-backup — no leads, §7).

**Preview copy:** "Edits show here a moment after you type. Nothing goes live until you publish."

---

## 8. Edge cases

1. Two pending creates with the same slug, or a pending slug equal to a live one → the DB unique violation at apply is mapped to the field (dry run shows it first).
2. A link to a pending create that is not selected → dependency auto-included; unticking it shows "Case 'X' needs it".
3. A parent removal with selected child changes → 422 "Section X is changed but its page is being removed".
4. Media hard delete while a draft references the asset → refused: `media_usage()` v4 lists drafts (any value equal to the asset id in the payload).
5. Restore across a hard-deleted asset or a reused slug → validation error listing them; never forced.
6. Swapping the slugs of two entities in one release → transient unique violation → error "rename in two releases" (documented).
7. Navigation key star moved → two drafts; `is_key=false` applies first (unique-flag ordering).
8. A scheduled release whose scheduler was demoted or deactivated → fails closed at fire, claims released, attention row.
9. Cron outage → late fire (attention "overdue"); a double run is a no-op.
10. A purge 429 on the Free plan → pending; the cron merges tags.
11. More than 30 tags → `tenant:default`.
12. A release of redirects only → `not_needed` + KV sync; `kvSynced:false` is surfaced.
13. A draft written straight through PostgREST with a malformed payload → excluded from preview with a reason; publish 422.
14. Rollback through a placeholder or sample-quote state in production → refused by the 0025 guard / 0028 sample lock under impersonation, exactly as for an edit.
15. `published_at` never rewritten (republish, rollback, unpublish keeps it); `updated_at` stamped at apply (truthful dateModified, §3 Pillar 3).
16. Developer previews: only areas Developer can read are overlaid (pages are readable via `maintenance.manage`, services are not).
17. Payload > 512 KB → 422. Release > 500 items → "publish in parts". > 1,000 drafts for one entity type → list overlay degrades with a warning.
18. AR completeness: `requireBilingual` at publish; `entity_seo` AR required (§3 Pillar 3).
19. The `site_profile` row is missing → a `create` draft merges defaults.
20. `accepting_applications` never appears in a site_profile draft (schema split); the guard lets the intake endpoint change it alone.
21. Releases switched off later (`app.disable_releases`): refuses while pending or scheduled items exist unless `force`; drafts stay, read-only, with a banner.
22. Concurrent publishers → serialised; the second gets 409 and refreshes.
23. A deleted entity's history → its release items stay; History lists "Removed in vN" with Restore.
24. Live preview with pending deletes → hidden in preview; with pending hides → hidden; with a pending show → visible (mirror rules).
25. Search, sitemap and llms only ever read live data.

---

## 9. Tests (§9)

**pgTAP** (`supabase/tests/`) — every file covers admin, content_creator, seo, developer, a `sales` claim, anon and other_tenant. The claim-based tests work before Sales joins the enum: policies read the role text from the claims.
- `rls_releases.test.sql`:
  - draft insert/update/delete per area and role;
  - delete/archive staging admin-only (redirects admin+seo);
  - claimed drafts immutable for staff;
  - releases and items read-only for every API role;
  - other_tenant sees zero rows and writes nothing;
  - anon has no privileges.
- `release_apply.test.sql`:
  - actor matrix: CC content update/publish ✓; CC archive/delete refused; SEO content refused; Developer content refused; Developer site_profile ✓; SEO entity_seo/redirect ✓; sales, inactive, locked and demoted actors BR403;
  - BR409 typed conflict;
  - atomic rollback on one bad item;
  - unknown column → 22023;
  - published_at rule;
  - 0025/0028/consent bind under impersonation;
  - capture of cascades and `portfolio_children`;
  - dry run leaves no rows and no number gap;
  - anon/authenticated cannot EXECUTE `apply_release`.
- `release_guard.test.sql`:
  - enabled tenant: staff direct writes refused with 42501; a GUC set in another txid refused;
  - allowed: inside apply, no-role/postgres, RI set-null from a profile delete, the exempt-column-only update;
  - disabled tenant: legacy writes allowed, so existing suites stay green.
- `release_schedule.test.sql`: claims lock drafts; fire as the scheduler binds RLS; demoted scheduler fails; double fire is a no-op; `enable_releases` conversion; `publish_scheduled` skips enabled tenants.
- `snapshot_coverage.test.sql`: every registry table has the snapshot + capture + guard triggers; `release_id` is set only inside a release.
- Updated: `grants_app_schema.test.sql` (new helpers on the allowlist; `content_versions` INSERT revoked), `rls_media_public.test.sql` (`media_usage` v4), `rls_portfolio_children.test.sql` (`save_portfolio` refactor unchanged).

**Authz (headline, §9)**
- `tests/authz/endpoints.spec.ts`: rows for every new endpoint × admin, content_creator, seo, developer, sales, anon, other_tenant. For publish, items of each area (content, removal, identity, theme, SEO, redirects) assert 2xx/403 per the §4.1 matrix.
- `tests/authz/releaseMatrix.spec.ts`: parses the §5 release table and proves it against `ROLE_CAPS` + `requiredCaps`.
- `tests/authz/matrix.spec.ts`: unchanged and green (no new capability).

**Unit / integration (vitest)**
- `tests/lib/releaseRegistry.spec.ts`: registry ↔ `resources.ts`/singletons parity; columns `toRow` can emit ⊆ the SQL allowlist literal; tags non-empty; apply order acyclic.
- `tests/lib/releaseOverlay.spec.ts`: merge; no-op drop; list overlay with creates, deletes, reorders, filters and search; three-way conflicts.
- `tests/lib/releaseValidate.spec.ts`: overlay-aware links; post-release redirect rules; dependencies; warnings; error mapping.
- `tests/lib/releaseTags.spec.ts`: old+new slugs; sitemap/llms; > 30 collapse; closure — every emitted tag is stamped by a route or `SECTION_READS`.
- `tests/lib/purge.spec.ts`: skipped without config; chunking; 429 retry with jitter; breaker; never throws.
- `tests/lib/releaseRevert.spec.ts`: as-of state from item chains, children included.
- `tests/lib/releaseCron.spec.ts`: fire, fail closed, purge retry merge.
- `tests/lib/contentSource.spec.ts`: concurrent public/preview contexts never cross; default anon.
- `tests/lib/previewClient.spec.ts` and `tests/lib/previewVisibility.spec.ts`: per fence, with fixtures.
- `tests/lib/previewBridge.spec.ts`: envelope, origin, source, targetOrigin.
- `tests/lib/previewRoutes.spec.ts`: every Tier A route is mapped.
- `tests/lib/securityHeaders.spec.ts`: `frame-src 'self'` only with the admin flag.
- `tests/lib/cacheTags.spec.ts`: section tags merged.
- `tests/lib/releaseWritePaths.spec.ts`: static — no admin route writes a registry table outside `src/lib/release`.

**E2E (Playwright, EN + AR; needs the R0 admin harness)**
- `releases-publish.e2e.ts`: CC edits a published service; the public page is unchanged; preview shows the edit; publish; the public page shows it; v increments; audit row.
- `releases-rollback.e2e.ts`: Restore v1 → preview → publish → public reverted; kind rollback.
- `releases-conflict.e2e.ts`: two contexts → `draft-conflict`; a runbook SQL live change → BR409 → Keep mine → publish.
- `releases-schedule.e2e.ts`.
- `releases-roles.e2e.ts`: SEO sees content as waiting and publishes `entity_seo`; Developer publishes identity.
- `preview-parity.e2e.ts`: with zero drafts, the normalized `<main>` text, section order and hrefs equal the public page for every Tier A route, EN and AR.
- `preview-isolation.e2e.ts`: preview headers are `private, no-store`, carry no `Cache-Tag` and are `noindex`; the draft appears only in preview; public HTML never loads the bridge.
- `csp.e2e.ts`: updated.
- axe on the savebar, dialog and ribbon (admin routes join `tests/a11y`).
- lhci/size-limit/layout-shift gates stay green after the route refactor.

---

## 10. Migration & rollout (forward-only, expand → flag → contract, §8)

Migrations take the next free number at merge (0030 is next today; the CRM and Sales slices interleave):
- `releases_core` (R1): tables, registry, helpers, flag column, snapshot coverage, grants — inert.
- `releases_apply` (R4): RPC, capture, children refactor, purge-record RPC — inert until called.
- `releases_guard` (R5): guard, `media_usage` v4, `dashboard_attention` v4 — inert while the flag is false.
- `releases_schedule` (R11): schedule mode, `enable_releases`/`disable_releases`, `publish_scheduled` skip.
- `releases_contract` (R15).

Each follows the 0022/0028 postcondition style: RLS forced, no anon write, invoker/definer as specified, EXECUTE allowlists.

**Code:** every staged branch sits behind `releasesEnabled()`. With the flag off, the admin behaves exactly as today, so slices can merge independently (one branch + PR per slice; CI green; Claude never merges).

**Switch-on** (runbook, R14):
1. Staging first: `select app.enable_releases('<tenant>', '<operator>', '<fallback admin>')`, run the full e2e suite in release mode, owner acceptance.
2. Production: announce a ~15-minute content freeze (no open editor forms) and run the same function. It writes baseline v1, converts scheduled rows and arms the guard.
3. Verify: the savebar appears; a trivial publish creates v2; the audit row and `content_release_items` exist; the public page updates.

**Rollback before contract:** `app.disable_releases` (publish or discard pending first). Legacy direct writes resume and the guard goes inert.

**Contract** (R15, after one stable cycle and owner sign-off): remove the legacy branches, unschedule the `publish-scheduled` cron, make `app.publish_scheduled()` a documented no-op, revoke EXECUTE on `save_portfolio` from authenticated, drop `scheduledFor` from the admin schemas.

**Risks:**

| Risk | Mitigation |
|---|---|
| Role switching depends on Supabase's authenticator memberships | pgTAP + staging check; documented definer fallback |
| AsyncLocalStorage propagation through Astro streaming in workerd | Buffered render inside the scope; e2e on a nested section; fallback: locals threading |
| Emulator / visibility drift | Parity e2e on every route; preview fidelity is the only impact |
| Editors expect Save = live | Savebar, badges, copy |
| A forgotten write path after switch-on | The guard fails it loudly; the static write-path test |
| Free-plan purge limits | Coalescing |
| History tables keep personal data (testimonials, team) | PDPL redaction (R16, owner/legal) |
| Admin bundle headroom (~82 KB) | No new dependencies; size-limit |

---

## 11. Standard amendments

Full texts are in `claudeMdAmendments`.
- **CLAUDE.md:** §1(4), §2 central tension + render tiers, §3 Pillar 1 (releases bullet, CSP frame-src, maintenance stays immediate), Pillar 3 (sitemaps/llms), Pillar 4 (drafts locking, purge resilience), §5 (release semantics + derived matrix), §7 (CSP line), §8 (lifecycle/scheduling, versioning, registry contract, drafts untrusted, file conventions incl. `contentClient()`), §9 (tests), §10 (minute cron, purge observability, `CF_CACHE_PURGE_TOKEN`).
- **`docs/architecture.md`:**
  - §1.4/§1.6: publish = release; R1 resolved — purge by tag is available on all plans, Free 5 requests/min; Cache API entries are purgeable by tag.
  - §2.4: drafts / releases / items; page history = the release items of the page and its sections.
  - §3.4: release matrix note.
  - §4.3: preview bridge + theme tokens.
  - §8.7: column-level conflicts.
- **`docs/design-port-2026-09.md`:** "Admin v2 — Releases (A3)" with A3-1…A3-14.
- **`docs/launch-runbook.md`:** enable/disable releases, the purge token, the minute cron.

## 12. Pre-existing findings surfaced while designing (for the program backlog)

1. `PATCH /api/admin/pages/visibility/[id]` (Developer, `maintenance.manage`) is refused by RLS `pages_write` (`can_write_content`), and `pages.nav_visible` has no public reader. The Developer half of §5 "page visibility" is unenforceable today. When the visibility feature is built it needs its own table (Phase-3 rule) and a `page_visibility` registry entry with `maintenance.manage`.
2. Staff can write live content through PostgREST without the Worker's Zod checks and sanitizers. Closed for release-managed tables by A3-5/A3-6.
3. `content_versions` is INSERT-granted to authenticated with a staff insert policy, so staff can forge history rows. Revoked in R1.
4. `docs/architecture.md` §1.6 says purge-by-tag is "Enterprise-only". That is stale: it is now available on all plans.
5. Page cache tags are static, while editors can add table-backed sections to any page. About lacks `certifications:all`/`testimonials:all`. Fixed by `SECTION_READS`.
6. Tier A edge caching itself does not exist yet (`*.workers.dev`, no Cache API layer; R43/KAN-20). The purge seam is ready, and that layer must never store `/admin/**`.
7. `custom_themes` delete is Admin-only in the Worker (`content.archiveDelete`), but RLS `custom_themes_write` lets Developer delete through PostgREST. Add a RESTRICTIVE delete policy when touching the table.

## Slices (design ids)

### R0: Admin e2e harness (shared prerequisite)

**Depends on:** none · **Effort:** M

Make admin journeys testable in CI. The perf-seo-a11y workflow notes there is no auth hook and no staff user, so no admin flow runs end to end today. Enable the Custom Access Token Hook for the local stack in supabase/config.toml (pg-functions://postgres/public/custom_access_token_hook). Seed one confirmed staff user per role (admin, content_creator, seo, developer; sales added by the Sales slice) through a CI-only seed that the production guard of seed.sql refuses. Add a Playwright loginAs(role) fixture with stored state. Skip if the shell/UI program already ships it.

**Key files:**

- supabase/config.toml
- supabase/seed.sql
- scripts/gen-seeds.mjs
- tests/fixtures/adminLogin.ts
- playwright.config.ts
- .github/workflows/perf-seo-a11y.yml

**Tests:**

- tests/e2e/admin-login.e2e.ts: every role signs in and lands on /admin; anon is redirected to /admin/login
- tests/seed/seeds.spec.ts: the staff-user seed refuses app.deployment = production

**Risks:**

- Hook config changes local auth for every developer — document it in README and the runbook
- Test credentials must never reach staging or production seeds

### R1: Release ledger schema (expand, inert)

**Depends on:** none · **Effort:** M

New migration with content_releases, content_drafts and content_release_items (RLS ENABLE+FORCE, tenant-first policies, stated grants, nothing for anon). Adds the app.release_entities registry, seeded with the design table: author/delete roles, writable columns, deferred columns, unique flags, exempt columns, apply order. Helpers app.is_cms_staff, app.can_author, app.can_stage_delete, app.release_token_valid and app.releases_enabled. site_settings.releases_enabled boolean default false. content_versions gains release_id; the snapshot trigger reads it; snapshot coverage is added for team_members, certifications, statistics, categories, navigation, redirects, entity_seo, custom_themes, and (new app.tg_snapshot_singleton) site_profile and seo_defaults. Revoke INSERT on content_versions from authenticated; content_versions_read moves to is_cms_staff. Postconditions in the 0022/0028 style. Zod shapes in packages/schemas/release.ts. No runtime behaviour change.

**Key files:**

- supabase/migrations/00NN_releases_core.sql
- packages/schemas/release.ts
- supabase/tests/rls_releases.test.sql
- supabase/tests/snapshot_coverage.test.sql
- supabase/tests/grants_app_schema.test.sql

**Migrations:**

- 00NN_releases_core.sql (next free number at merge; 0030 if first)

**Tests:**

- pgTAP rls_releases over admin, content_creator, seo, developer, sales claim, anon and other_tenant: draft insert/update/delete per area; delete-op staging admin-only (redirects admin+seo); archive staging admin-only; claimed drafts immutable for staff; releases/items read-only for every API role; other_tenant zero rows
- pgTAP snapshot_coverage: every registry table has its snapshot trigger, and release_id is set only inside a release token
- grants_app_schema allowlist updated (new helpers; content_versions INSERT revoked from authenticated)
- vitest: packages/schemas release schemas (limits, control characters, uuids)

**Risks:**

- Sales denial relies on explicit role lists — the Sales slice must not widen is_cms_staff
- Keep the 0009 staff insert policy so the definer snapshot path still works on a non-BYPASSRLS owner after the grant is revoked
- A registry table without tenant_id needs the app.deployment-style justification under §8

### R2: Release registry, caps and overlay core (TS only)

**Depends on:** R1 · **Effort:** M

src/lib/release/registry.ts maps each entity type to its table, key, area, ResourceConfig/SingletonConfig, author/publish/remove caps, apply order, tags(before, after) and label. caps.ts holds requiredCaps, canPublish and the roles each item is waiting for, from ROLE_CAPS. overlay.ts does payload merge, patch derivation through the entity schema plus toRow, row and list overlay (creates, deletes, reorders, filters, search), no-op detection and three-way conflict detection. ResourceConfig gains introspectable fields maps (payload key to columns, derived ones included) and toRow is rebuilt on them; publishStamp is disabled in staged mode. A derived release publish matrix table is added to architecture.md and the proposed §5 text.

**Key files:**

- src/lib/release/registry.ts
- src/lib/release/caps.ts
- src/lib/release/overlay.ts
- src/lib/admin/resources.ts
- src/lib/admin/resource.ts
- docs/architecture.md

**Tests:**

- tests/lib/releaseRegistry.spec.ts: registry parity with resources.ts and singletons; columns toRow can emit are a subset of the SQL allowlist literal; tags non-empty except redirect; apply order acyclic
- tests/lib/releaseOverlay.spec.ts: merge, no-op drop, list overlay with creates/deletes/reorders/filters/search, three-way conflicts
- tests/authz/releaseMatrix.spec.ts: the documented release matrix equals requiredCaps evaluated against ROLE_CAPS

**Risks:**

- Drift between the TS fields maps and app.release_entities.columns (the RPC raises on unknown columns; the test literal pins it)
- Overlay paging semantics when pending creates exist

### R3: Staged writes in the admin kernel (behind releases_enabled)

**Depends on:** R2 · **Effort:** L

resource.ts (collection, item and reorder routes) and singleton.ts gain a staged branch. Create becomes an op=create draft with a pre-allocated id. PATCH merges the payload with version plus draftVersion: 409 draft-conflict, draft-published or scheduled; no-op drafts are dropped. DELETE stages op=delete or discards a pending create; reorder writes sortOrder drafts. GET item, list and singleton return live merged with the draft plus draft meta, and pickers overlay too. entity-seo GET/PUT is staged. accepting_applications moves to an immediate PATCH /api/admin/site-profile/intake (Admin; guardWrite plus the 0019 trigger). Draft endpoints: pending summary, discard one/mine/selected, resolve conflicts. releasesEnabled is per request in the kernel context; audit actions draft_save and draft_discard. The legacy branch is untouched while the flag is off.

**Key files:**

- src/lib/admin/resource.ts
- src/lib/admin/singleton.ts
- src/lib/admin/crud.ts
- src/lib/admin/route.ts
- src/lib/release/drafts.ts
- src/pages/api/admin/releases/pending.ts
- src/pages/api/admin/drafts/[id].ts
- src/pages/api/admin/drafts/discard.ts
- src/pages/api/admin/drafts/[id]/resolve.ts
- src/pages/api/admin/site-profile/intake.ts
- src/pages/api/admin/entity-seo.ts
- src/pages/api/admin/site-profile.ts

**Tests:**

- tests/lib/stagedKernel.spec.ts: flag off keeps the legacy path; flag on writes drafts; 409 paths; no-op drop; archive/delete staging caps; status scheduled refused
- tests/lib/stagedSingleton.spec.ts: the intake split keeps accepting_applications Admin-only in both layers
- tests/authz/endpoints.spec.ts: rows for every new endpoint over admin, content_creator, seo, developer, sales, anon, other_tenant
- tests/lib/adminResources.spec.ts: registry and uiSchema parity still green

**Risks:**

- Largest behaviour surface — list overlay correctness
- Forms must send draftVersion; the legacy UI must keep working while the flag is off

### R4: apply_release RPC and change capture (SQL)

**Depends on:** R1 · **Effort:** L

public.apply_release: SECURITY INVOKER, EXECUTE for service_role only. Checks the live actor, takes a per-tenant advisory lock and checks draft locks and versions. Impersonates the publisher (SET LOCAL ROLE authenticated plus claims built from profiles). Applies items with dynamic SQL driven by app.release_entities (identifiers via %I, values via USING); unknown columns raise. Typed column-level conflict check; first-publish published_at rule; deferred self-reference pass; unique-flag ordering; per-item error collection with custom SQLSTATEs BR403/BR409/BR422; dry run through a caught BRDRY. Finalises the ledger and writes the audit_log row in the same transaction. app.apply_portfolio_children is extracted from save_portfolio (signature unchanged), with synthetic portfolio_children items; the custom theme single-active hook; record_release_purge for service_role. app.tg_release_capture AFTER triggers on every registry table. Postconditions: not prosecdef, no anon/authenticated EXECUTE.

**Key files:**

- supabase/migrations/00NN_releases_apply.sql
- supabase/tests/release_apply.test.sql
- supabase/tests/rls_portfolio_children.test.sql

**Migrations:**

- 00NN_releases_apply.sql

**Tests:**

- pgTAP release_apply, actor matrix: CC publishes content; CC archive/delete refused by RESTRICTIVE gates; SEO and Developer content refused; Developer site_profile allowed; SEO entity_seo/redirect allowed; sales, inactive, locked and demoted actors get BR403; other-tenant items refused
- Typed conflict detection (numeric formatting included) gives BR409; one bad item rolls the whole release back; an unknown column raises 22023
- published_at is kept on republish and stamped at apply; the 0025 placeholder guard, the consent CHECK and the 0028 sample lock still bind under impersonation
- Capture records cascades (service to service_case, page to sections, team member to blog author set null) and portfolio children
- dry_run persists nothing and leaves no number gap; anon and authenticated cannot EXECUTE

**Risks:**

- Role switching inside an RPC depends on authenticator being a member of authenticated and service_role (Supabase default) — verify on staging; documented SECURITY DEFINER fallback
- Dynamic SQL correctness — the 500-item cap bounds lock time

### R5: Release guard, media_usage v4, dashboard_attention v4 (SQL)

**Depends on:** R4 · **Effort:** M

app.tg_release_guard BEFORE triggers on every registry table plus portfolio_media/portfolio_services, inert while releases_enabled is false. When armed it refuses a staff JWT write outside a release with 42501 and a hint. Exemptions: no role claim (seeds, runbook, cron), pg_trigger_depth > 1 (RI actions), the release token, and exempt-column-only updates (site_profile.accepting_applications). media_usage v4 lists pending drafts that reference an asset, so hard delete is refused. dashboard_attention v4 adds release_scheduled_today, release_overdue, release_failed, purge_failed and draft_stale. app.publish_scheduled skips tenants with releases enabled.

**Key files:**

- supabase/migrations/00NN_releases_guard.sql
- supabase/tests/release_guard.test.sql
- supabase/tests/rls_media_public.test.sql

**Migrations:**

- 00NN_releases_guard.sql

**Tests:**

- pgTAP release_guard, enabled tenant: CC direct insert/update/delete refused; a GUC set in another txid refused; allowed inside apply, for no-role/postgres, for a profile delete cascading to team_members, and for an exempt-column-only update
- Disabled tenant: legacy direct writes allowed, so every existing suite stays green
- media_usage includes drafts; dashboard_attention shapes; publish_scheduled ignores enabled tenants

**Risks:**

- A forgotten Worker write path fails loudly after switch-on (intended); R14 adds the static write-path test

### R6: Publish and validate endpoints

**Depends on:** R3, R4, R0 · **Effort:** L

POST /api/admin/releases (publish now) and POST /api/admin/releases/validate (Worker validation plus a DB dry run). Per-item requiredCaps through assertCap; liveRecheck; payloads re-parsed with Zod plus toRow. assertWritable/assertPublishable are refactored to an overlay-aware db (exists/get/list), so links to pending creates and the post-release redirect chain and live-route rules work. Dependency computation and warnings. BR409/BR422 details mapped to items and fields through constraintFields and writeRefusals. The service-client RPC call carries p_actor and p_role, and the post-apply hooks are never fatal.

**Key files:**

- src/pages/api/admin/releases/index.ts
- src/pages/api/admin/releases/validate.ts
- src/lib/release/validate.ts
- src/lib/release/apply.ts
- src/lib/admin/resources.ts
- src/lib/admin/redirectRules.ts
- src/lib/admin/liveRecheck.ts

**Tests:**

- tests/lib/releaseValidate.spec.ts: bilingual, placeholder, consent, poster alt, discipline required; a redirect plus its rename in one release passes; dependency pull-in; warnings for services hidden by an unpublished discipline
- tests/authz/endpoints.spec.ts: content item admin+CC 2xx and SEO/Developer/sales 403; identity and theme items admin+Developer; SEO items admin+SEO; delete/archive admin only; anon 401
- tests/e2e/releases-publish.e2e.ts: a CC edit of a published service stays off the public page until published; v increments; audit row written

**Risks:**

- Validation must see the post-release state
- Payload re-derivation must equal what the editor saw (same toRow)

### R7: Purge seam, tag closure, minute cron

**Depends on:** R2, R6 · **Effort:** M

src/lib/http/purge.ts calls the Cloudflare purge_cache API by tags: at most 30 per call, otherwise tenant:default; backoff with jitter and a breaker; never throws; without CF_ZONE_ID/CF_CACHE_PURGE_TOKEN it is skipped and logged once. src/lib/release/tags.ts maps items to tags with old and new slugs, sitemap/llms on URL changes, and section page slugs. src/lib/sections/reads.ts (SECTION_READS) makes page tags the route tags plus the rendered sections' tags. Cache-Tag on sitemap.xml and llms.txt. Post-apply effects: purge, syncRedirectsToEdge, record_release_purge; media metadata saves purge media:all. The wrangler minute cron, src/worker.ts dispatch and src/lib/cron/releases.ts retry pending purges. Optional astro:env entries; push-secrets entry.

**Key files:**

- src/lib/http/purge.ts
- src/lib/release/tags.ts
- src/lib/http/cacheTags.ts
- src/lib/sections/reads.ts
- src/pages/sitemap.xml.ts
- src/pages/llms.txt.ts
- src/worker.ts
- src/lib/cron/releases.ts
- wrangler.jsonc
- astro.config.mjs
- scripts/push-secrets.mjs

**Tests:**

- tests/lib/purge.spec.ts: skipped without config, chunking/collapse, 429 retry with jitter, breaker, never throws
- tests/lib/releaseTags.spec.ts: closure — every emitted tag is stamped by a route or SECTION_READS; every registry type maps; more than 30 collapses
- tests/lib/cacheTags.spec.ts: section tags merged into page tags
- tests/lib/releaseCron.spec.ts: purge retries merge pending releases

**Risks:**

- Free plan allows 5 purge requests per minute — coalesce in the cron
- Tags only matter once a Tier A cache exists (R43/KAN-20); a failed purge means stale pages until retried, surfaced on the dashboard

### R8: Preview data seam: contentClient and overlay client

**Depends on:** R2 · **Effort:** L

src/lib/data/source.ts adds an AsyncLocalStorage-scoped contentClient() that defaults to anonClient(). Every public loader moves from anonClient() to contentClient() (15 files), and a test forbids anonClient() elsewhere. src/lib/preview/client.ts emulates the PostgREST subset the loaders use: select with aliased and nested embeds, eq/neq/in/is/contains/order/limit/range/maybeSingle/single; rpc is unsupported. relations.ts holds the FK map. visibility.ts mirrors anon RLS, each rule commented with its migration. dataset.ts reads live rows through the staff client (capped, memoized per request) and overlays drafts in areas the caller can read, each re-parsed; invalid drafts are reported, not overlaid.

**Key files:**

- src/lib/data/source.ts
- src/lib/data/services.ts
- src/lib/data/pageSections.ts
- src/lib/preview/client.ts
- src/lib/preview/relations.ts
- src/lib/preview/visibility.ts
- src/lib/preview/dataset.ts

**Tests:**

- tests/lib/contentSource.spec.ts: concurrent public and preview contexts never cross; the default is the anon client
- tests/lib/previewClient.spec.ts: select parsing including nested embeds; filters, ordering, single semantics; unknown methods throw
- tests/lib/previewVisibility.spec.ts: fixtures for every fence (discipline, published parent, visible, entity_seo parent, media public read)

**Risks:**

- Emulator or visibility drift from PostgREST/RLS affects preview fidelity only; the R9 parity e2e guards it
- AsyncLocalStorage propagation through Astro streaming in workerd (R9 buffers inside the scope; fallback threads locals)

### R9: Preview route, layout mode, bridge and CSP

**Depends on:** R8, R0 · **Effort:** L

Refactor every Tier A route into a load function plus a view component, and add src/pages/admin/preview/[...path].astro with src/lib/preview/routes.ts (EN and AR, preview 404). Middleware preview branch: CMS read caps, overlay source, next() run and buffered inside withContentSource; Cache-Tag stripped from every private response; X-Robots-Tag noindex. BaseLayout preview mode: no consent banner, telemetry or error reporter; ribbon; noindex; data-pv-section ids; preview.css; bridge script. CSP frame-src self for /admin responses only (a buildCsp option). Bridge (admin-* chunk), parent channel and the Zod envelope in packages/schemas/previewMessage.ts: targetOrigin location.origin, origin and source checks, link and form interception, theme tokens as CSS custom properties. size-limit entries.

**Key files:**

- src/pages/admin/preview/[...path].astro
- src/lib/preview/routes.ts
- src/middleware.ts
- src/lib/http/securityHeaders.ts
- src/layouts/BaseLayout.astro
- src/components/SectionRenderer.astro
- src/scripts/previewBridge.ts
- src/lib/admin/previewChannel.ts
- packages/schemas/previewMessage.ts
- public/styles/preview.css
- .size-limit.json
- astro.config.mjs

**Tests:**

- tests/e2e/preview-parity.e2e.ts: with zero drafts, normalized main text, section order and hrefs equal the public page for every Tier A route in EN and AR
- tests/e2e/preview-isolation.e2e.ts: preview is private no-store with no Cache-Tag and noindex; a draft appears only in preview; public HTML never references the bridge
- tests/lib/securityHeaders.spec.ts and tests/e2e/csp.e2e.ts: frame-src self only on admin responses
- tests/lib/previewBridge.spec.ts and tests/lib/previewRoutes.spec.ts; axe on the preview ribbon

**Risks:**

- The route refactor touches every public page — lhci LCP/CLS and layout-shift gates must stay green
- Preview must never reach any cache; a bridge script on public pages would break the 100 KB public budget (asserted)

### R10: Versions, history, restore and as-of preview

**Depends on:** R6, R9, R5 · **Effort:** L

GET /api/admin/releases (list) and GET /api/admin/releases/[id] (items filtered by read caps, field-level diff). POST /api/admin/releases/[id]/restore stages the state at vN; it refuses when those entities have pending changes or the caller lacks caps for any area. GET /api/admin/history and POST /api/admin/history/restore (content_versions with release numbers; per-item restore to a draft). The as-of overlay in src/lib/release/revert.ts is reused by the preview dataset (?v=n). POST /api/admin/releases/[id]/purge retries a purge. Adds a staff_directory view only if the dashboard slice has not.

**Key files:**

- src/pages/api/admin/releases/[id].ts
- src/pages/api/admin/releases/[id]/restore.ts
- src/pages/api/admin/releases/[id]/purge.ts
- src/pages/api/admin/history.ts
- src/pages/api/admin/history/restore.ts
- src/lib/release/revert.ts
- src/lib/preview/dataset.ts

**Migrations:**

- 00NN_staff_directory.sql (only if not already provided by the dashboard slice)

**Tests:**

- tests/lib/releaseRevert.spec.ts: as-of state from create/update/delete chains and portfolio children
- tests/e2e/releases-rollback.e2e.ts: publish v2, restore v1, preview shows v1, publish, public shows v1, release kind rollback
- tests/authz/endpoints.spec.ts: restore and history rows per role, including cross-area restore refused for a Content Creator

**Risks:**

- Restoring entities whose slug is reused or whose media was hard-deleted gives validation errors (expected)
- An as-of preview renders old content with today's code and today's media metadata (documented)

### R11: Scheduled releases and switch-on functions

**Depends on:** R6, R7, R5 · **Effort:** L

Schedule mode of apply_release (validated payload stored, drafts claimed). PATCH/DELETE /api/admin/releases/[id] to reschedule or unschedule, cap-checked. The Worker minute cron fires due releases through apply_release mode fire as the scheduler, after re-checking requiredCaps against the live role; if that fails, the release is marked failed, claims are released, system_logs and attention are written. Then it purges. app.enable_releases(tenant, operator, fallback_scheduler) writes baseline v1, converts legacy scheduled rows into drafts and legacy_schedule releases (live status moves from scheduled to draft), sets the flag and audits. app.disable_releases refuses while items are pending or scheduled unless forced. Both are runbook-only, revoked from API roles. Zod refuses status scheduled in staged payloads.

**Key files:**

- supabase/migrations/00NN_releases_schedule.sql
- src/lib/cron/releases.ts
- src/pages/api/admin/releases/index.ts
- src/pages/api/admin/releases/[id].ts
- packages/schemas/release.ts
- docs/launch-runbook.md

**Migrations:**

- 00NN_releases_schedule.sql

**Tests:**

- pgTAP release_schedule: claims lock drafts; firing as the scheduler binds RLS (a CC-scheduled archive is refused); a demoted scheduler fails closed; double fire is a no-op; enable_releases conversion; publish_scheduled skips enabled tenants
- tests/lib/releaseCron.spec.ts: fire path, fail closed, overdue detection
- tests/e2e/releases-schedule.e2e.ts: schedule a minute ahead, run the cron handler, the public page shows the change

**Risks:**

- Minute granularity; a cron outage delays firing (dashboard shows overdue)
- Legacy conversion needs a named fallback scheduler for rows with no recorded updater

### R12: Release UX I: savebar, publish dialog, conflicts, badges

**Depends on:** R6, R7, R9 · **Effort:** L

Build the islands from the UX contract. Savebar: counts by area, waiting count, Discard menu, Preview, Publish. PublishDialog: grouped selectable items with dry-run status, dependencies, a waiting section, note, now or schedule in Riyadh time, results. ConflictPanel: keep mine, use live, compare. PendingBadge on lists and editor headers. Form changes: send draftVersion, hide per-item schedule, a Visible on the site toggle, keep values on 409. Live-region announcements, reduced motion, CSP-safe classes and data attributes, size-limit entries. Also depends on the shell/design-system slices of the UI program.

**Key files:**

- src/components/admin/release/Savebar.tsx
- src/components/admin/release/PublishDialog.tsx
- src/components/admin/release/ConflictPanel.tsx
- src/components/admin/release/PendingBadge.tsx
- src/components/admin/ResourceForm.tsx
- src/components/admin/ResourceTable.tsx
- src/components/admin/SingletonForm.tsx
- src/layouts/AdminLayout.astro
- public/styles/admin.css
- .size-limit.json

**Tests:**

- tests/lib/adminFields.spec.ts updated for the new controls
- tests/e2e/releases-ui.e2e.ts: savebar counts, publish happy path, conflict flow, role-scoped publish (SEO sees content as waiting)
- axe on the savebar and dialog (admin routes added to tests/a11y)

**Risks:**

- Admin bundle headroom (about 82 KB) — no new dependencies
- Toast copy must stay truthful about the cache state

### R13: Release UX II: versions page, history drawer, dashboard card

**Depends on:** R10, R11, R12 · **Effort:** M

Settings › Backups & versions: version timeline, scheduled and failed releases, Preview/Restore/Details, and a Backups card with Download content only. HistoryDrawer on every editor. Dashboard Publish status card backed by GET /api/admin/releases/status. A nav entry in src/lib/admin/nav.ts gated on release read caps (none for Sales).

**Key files:**

- src/components/admin/release/VersionsPanel.tsx
- src/components/admin/release/HistoryDrawer.tsx
- src/components/admin/release/PublishStatusCard.tsx
- src/pages/admin/settings/versions.astro
- src/pages/api/admin/releases/status.ts
- src/lib/admin/nav.ts
- src/pages/admin/index.astro

**Tests:**

- tests/lib/adminSecurity.spec.ts: nav per role (Sales has no Versions entry)
- tests/e2e: restore from the versions page; history drawer preview and restore
- axe on the versions page and drawer

**Risks:**

- Staff names need a staff-directory read for non-admins

### R14: Switch-on: standard amendments, runbook, CI default

**Depends on:** R3, R5, R6, R7, R9, R10, R11, R12, R13 · **Effort:** M

CLAUDE.md amendments (§1, §2, §3, §5 with the derived release matrix, §7, §8, §9, §10). docs/architecture.md (§1.4, §1.6 with R1 resolved, §2.4, §3.4 note, §4.3, §8.7). docs/design-port-2026-09.md section Admin v2 — Releases (A3) with decisions A3-1 to A3-14. Launch-runbook section: freeze, app.enable_releases, verification, disable path. CI seed enables releases for the launch tenant so every e2e runs in release mode. A static test that no admin route writes a registry table outside src/lib/release. Remove the per-item schedule UI.

**Key files:**

- CLAUDE.md
- docs/architecture.md
- docs/design-port-2026-09.md
- docs/launch-runbook.md
- supabase/seed.sql
- tests/lib/releaseWritePaths.spec.ts

**Tests:**

- tests/authz/matrix.spec.ts still green (no new capability)
- tests/authz/releaseMatrix.spec.ts parses the new §5 release table
- The full e2e suite runs in release mode in CI

**Risks:**

- Editors must learn that save is not live — onboarding copy
- Switch-on must happen with no editor forms open (freeze window)

### R15: Contract: remove legacy write paths

**Depends on:** R14 · **Effort:** S

After one stable cycle with releases on and owner sign-off: delete the flag-off branches in resource.ts and singleton.ts; releases become the only mode (the column stays). Unschedule the publish-scheduled pg_cron job and make app.publish_scheduled a documented no-op. Revoke EXECUTE on save_portfolio from authenticated (the apply uses the shared children function). Drop scheduledFor from the admin schemas.

**Key files:**

- src/lib/admin/resource.ts
- src/lib/admin/singleton.ts
- packages/schemas/admin.ts
- supabase/migrations/00NN_releases_contract.sql

**Migrations:**

- 00NN_releases_contract.sql

**Tests:**

- pgTAP grants: save_portfolio not executable by authenticated; the publish-scheduled job is absent
- Kernel tests without the legacy branch

**Risks:**

- Only reversible with a new expand migration — run it only after the owner signs off the cycle

### R16: PDPL history redaction (owner/legal-gated)

**Depends on:** R4, R14 · **Effort:** S

An Admin-only, live-rechecked, doubly audited operation (the DSAR pattern of job applications). For one entity, it redacts personal fields (testimonial quote, author name and role, avatar; team name, bio, portrait; consent reference) across content_versions, content_release_items and drafts, after deletion or consent withdrawal. Ledger ids, ops and timestamps are kept.

**Key files:**

- supabase/migrations/00NN_history_redaction.sql
- src/pages/api/admin/history/redact.ts

**Migrations:**

- 00NN_history_redaction.sql

**Tests:**

- pgTAP: only Admin may redact; other tenants untouched; ledger rows keep ids and ops
- tests/authz/endpoints.spec.ts rows; two audit entries (attempt and outcome)

**Risks:**

- Redacted versions cannot be restored or previewed faithfully
- Must never touch audit_log (hash chain)

## Proposed standard amendments

- §1(4) Admin / CMS: append 'Publishing is a site-wide release: editors stage pending changes, preview them, and publish them together as a numbered version that can be restored (docs/design-port-2026-09.md, Admin v2 — Releases).'
- §2 Central tension: replace '(a published edit never triggers a full rebuild)' with '(a published release never triggers a full rebuild)'. Replace 'tag-based edge cache invalidation tied to publish' with 'tag-based edge cache invalidation tied to each release'. Add: 'Every CMS edit to public content is staged as a pending change (content_drafts, one per entity) and reaches the live tables only inside a release: one transaction (public.apply_release) applies the selected changes, records a numbered site version (content_releases, content_release_items) and then purges the union of their cache tags (at most 30 tags, else tenant:<tid>). Editing never changes the live site; publishing never rebuilds.'
- §2 Render tiers: add under Tier C '/admin/preview/** — a staff render of public routes with pending or past content overlaid (private, no-store, noindex, Cache-Tag stripped, never stored by any cache layer). The preview bridge script ships only there.' Change the indexable-content rule sentence to 'Publish (a release) = one transaction + one cache event, never a rebuild.'
- §3 Pillar 1, new bullet 'Releases': live content tables change only inside a release. public.apply_release is SECURITY INVOKER and only service_role may execute it. It impersonates the publisher's live profile (role, tenant, is_active, locked_until), so RLS and every RESTRICTIVE publish/archive/delete gate bind to that user. The Worker re-validates every item (Zod, domain rules, per-item assertCap, liveRecheck) before calling it. A guard trigger refuses a staff JWT's direct write to a release-managed table outside a release. A scheduled release applies as its scheduler, re-checked live at fire time. Drafts are untrusted input, re-parsed by every consumer.
- §3 Pillar 1, CSP bullet and §7: add 'frame-src adds self on /admin/** responses only (the page editor frames /admin/preview); public responses never frame same-origin. The preview bridge uses an explicit targetOrigin (location.origin), checks origin and source, uses a Zod envelope (packages/schemas/previewMessage.ts), and applies theme tokens as CSS custom properties only.'
- §3 Pillar 1, maintenance bullet: add 'Maintenance mode is never staged: it is an immediate, confirmed switch outside the release model (also users, integrations, technical settings, accepting_applications, leads/CRM, job applications, media binaries and metadata).'
- §3 Pillar 3: replace 'Sitemaps + llms.txt regenerate on publish' with 'Sitemaps + llms.txt render from live data and carry seo:sitemap / seo:llms tags, which every release that changes a URL-bearing entity purges.'
- §3 Pillar 4, optimistic locking: add 'Pending changes carry their own version; publish detects column-level conflicts against the draft's base (409 listing the fields). Cache purges go through src/lib/http/purge.ts only, with backoff, jitter, a breaker and cron retries.'
- §5: add after the canonical role model 'Publishing is a release. A role may publish exactly the pending items whose area capabilities it holds: content items need their write capability plus content.publish; removals and archives need content.archiveDelete; identity needs settings.general; theme needs theme.edit; SEO items need seo.entityMeta / seo.globalDefaults; redirects need redirects.manage. Releases add a review step and never widen who can change the live site; anon, other_tenant and Sales are denied.' Then add the derived Release publish matrix table, proven against ROLE_CAPS by tests/authz/releaseMatrix.spec.ts.
- §8 Data model, lifecycle: 'A row's content_status changes only through a release. Scheduling is a property of a release (content_releases.scheduled_for), not of a row: release-managed tables no longer use status scheduled (legacy rows are converted by app.enable_releases); the enum keeps it for tables outside the registry.'
- §8 Data model, versioning: 'content_versions stays the single per-entity history; every release-managed table snapshots into it, and each snapshot carries the release_id that produced it. Site versions are content_releases (numbered per tenant when they go live, baseline v1 at switch-on) with append-only content_release_items (before/after images captured by trigger, cascades included). Rollback is a new release restoring before-images. There is still no page_versions table.'
- §8 Data model, new bullet 'Release registry contract': a table joins app.release_entities only if every CMS role may read it, its write policies and RESTRICTIVE gates already say who may author and remove it, it carries id/tenant_id/version and the standard triggers, and it gets the snapshot, capture and guard triggers in the same migration. A table whose columns belong to two capabilities is split first.
- §8 File/layout conventions: add src/lib/release/* (registry, caps, overlay, drafts, validate, tags, revert), src/lib/http/purge.ts, src/lib/preview/* and src/pages/admin/preview/[...path].astro. Add the rule 'public loaders read through contentClient() (src/lib/data/source.ts), never anonClient() directly; a public request always gets the anon client, and only the /admin/preview branch of src/middleware.ts may install an overlay'.
- §9 Testing: add 'pgTAP for content_drafts / content_releases / content_release_items / apply_release / the release guard over admin, content_creator, seo, developer, sales, anon, other_tenant; endpoint rows for every release endpoint and per-area publish; e2e draft -> preview -> publish -> public, rollback, conflict, schedule; preview parity (zero drafts equals public on every Tier A route, EN and AR) and preview isolation (private no-store, no Cache-Tag, noindex, no bridge on public pages).'
- §10: add 'The Worker runs a minute cron besides the daily one: it fires due scheduled releases through the same apply RPC and retries pending cache purges. Purge outcomes are recorded on the release, in system_logs and on the dashboard. CF_CACHE_PURGE_TOKEN (Zone Cache Purge only) is a Worker secret; CF_ZONE_ID is a server var; until the zone exists the purge is a logged no-op.'

## Owner items

- Provision the Cloudflare zone and custom domain (KAN-20) and a Zone · Cache Purge-only API token. It becomes the CF_CACHE_PURGE_TOKEN Worker secret, with CF_ZONE_ID as a server var. Confirm the plan: the Free plan allows 5 purge requests/min, which the design coalesces around. Decide when the Tier A edge cache layer (R43) is built — until then purges are no-ops and pages are always fresh.
- Approve the publish semantics: a release adds a review step and never widens who can change the live site. Approve the derived release publish matrix for §5, in particular Developer publishing identity/theme and SEO publishing SEO and redirects, as each can save them live today.
- Decide the scope of Publish: default 'everything I may publish' with an opt-out per item (proposed), or strict all-or-nothing of every publishable item.
- Pick the switch-on window (about a 15-minute content freeze) and the operator who runs app.enable_releases on staging and then production. Name the fallback Admin used as scheduler for legacy scheduled rows that have no recorded updater.
- PDPL/legal: content_versions, release items and drafts keep testimonial authors' words and team members' bios after deletion or consent withdrawal. Approve a redaction procedure (slice R16) and a retention period for release history.
- Decide whether a release note is optional (proposed, default shown as 'Published from the admin') or required.
- Page visibility for Developer (§5 'hidden pages / page visibility') is not enforceable today: RLS refuses the existing visibility endpoint. Approve moving page visibility into its own table when the visibility feature is built, published under maintenance.manage.
- Confirm that one-minute scheduling granularity is acceptable, and that a second Worker cron trigger is fine (2 of the plan's allowance).

## Open questions

- Should SEO and Developer previews overlay only pending changes in areas they can read (proposed), or every pending change on the site?
- Should pending changes expire or only be flagged? Proposed: a dashboard 'stale draft' row after 30 days, no automatic expiry.
- Should the Style-Finder questions/styles join the release registry when the quiz ships, or stay immediate?
- Should autosave draft writes be audited like explicit saves? Proposed: yes, field names only, with an autosave interval of at least 30 s for long forms.
- Is a fire delay of up to 1 minute (Worker cron) acceptable, or should scheduled releases also be triggered by a pg_net webhook to the Worker for exact timing?
- Should admin global search include pending creates (labels from drafts), or stay live-only in v1 as proposed?
- Once the zone exists: what s-maxage should sitemap.xml/llms.txt and redirect responses carry, given they become purgeable by tag?
- Should 'Restore vN' also be offered as 'Undo only release N' (revert one release's items when nothing touched them since), or is site-level restore enough?
- Is a staff_directory view (id, display_name for CMS staff) acceptable to show author names to non-admins? profiles is admin-read-only today, and the dashboard activity widget needs the same view.

## Deviations from the prototype

- Publish is role-scoped. It publishes only the changes your role may publish; the rest wait, shown as 'N waiting for someone who can publish'. In the mockup anyone with 'publish' publishes everything, and its Developer could publish content, which §5 forbids.
- The publish dialog lets you untick items (default: all ticked) and auto-includes dependencies. The mockup has a single Publish with no list.
- Discard throws away pending changes (mine, or chosen items, with a confirm naming other authors). It never resets the database, and scheduled (locked) changes cannot be discarded until they are unscheduled. The mockup's Discard wipes the whole demo database and has no permission check.
- Maintenance, users, integrations, technical settings, the job-application intake switch, leads/CRM, media uploads and media alt/tags save immediately. The mockup stages maintenance and general settings behind Publish; its copy 'Maintenance mode is off after you publish' becomes immediate copy.
- Version numbers start at v1, a baseline written when releases are switched on, and are assigned when a release goes live. Scheduled releases show a date, not a number (the mockup seeds v11–v14).
- Restore stages the old version as unpublished changes to review and publish. The mockup copy 'vN restored. Publish to make it live.' is kept, but versions never include leads, and backups are content-only downloads (export-backup).
- Preview is a real server render that refreshes about 1 second after an autosaved edit. It does not patch text per keystroke, and the copy changes from 'nothing is saved until you publish' to 'nothing goes live until you publish' (pending changes are saved on the server).
- Scheduling is per release, set in the publish dialog. The per-item Schedule field disappears from editors.
- The history drawer lists real per-item versions with their release number, and Preview/Restore work. The mockup shows fake site-wide versions whose buttons only toast.
- A conflicts panel exists (keep mine / use the live version / compare); the mockup has no concurrency handling.
- Previewing an old version renders its content with today's design and today's media metadata.
- The savebar is hidden for Sales and on the login page. Preview never sends analytics, consent prompts or form submissions.
- Backups & versions is available to every CMS role, with items filtered by what each role may read. In the mockup only owner/developer reach it and Admin is locked out.
- The page editor's Publish button opens the same site-wide publish dialog, scrolled to that page's changes, rather than publishing the page alone.
- Live preview cannot use postMessage with '*' and raw HTML. The bridge uses an explicit same-origin targetOrigin, checks origin and source, uses a Zod envelope, and applies theme tokens only as CSS custom properties.
