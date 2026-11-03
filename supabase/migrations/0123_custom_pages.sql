-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0123 — Custom pages (Admin v2 E11, AV-33). Forward-only and EXPAND only. The number is a
-- placeholder: it is assigned at merge (scripts/renumber-migration.mjs). Depends on 0001
-- (public.pages, its unique (tenant_id, slug) and pages_write), 0007 (the Admin-only archive
-- and delete gates), 0009 (the actor, version and snapshot triggers), 0038 (the release
-- registry's page row) and 0057 (pages_route_slug_fixed).
--
-- The design is docs/admin-v2/ui.md AV-33 ("New page dialog: EN and AR title plus slug";
-- "Tier A [slug] and /ar/[slug] routes"; risk: "Route collision with fixed routes (reserved
-- slugs)"); what was built and every departure is docs/admin-v2/as-built/E11.md.
--
-- A custom page is a `pages` row whose slug is not one of the seven route slugs: it renders at
-- `/<slug>` and `/ar/<slug>` (src/pages/[slug].astro). No kind column: the slug says which a
-- page is. What the database adds is one rule on the slug, for EVERY writer (staff tokens, the
-- service role, a release's apply, the migration role), so the address a page takes can never
-- be a path the site already answers:
--
--   app.tg_pages_slug_rules(), BEFORE INSERT OR UPDATE OF slug on public.pages, row level.
--   On an insert, and on an update that changes the slug (a save that sends it unchanged is
--   not a rename, as 0057's trigger reads it):
--     • the shape: lowercase letters and digits in words joined by single hyphens, 1 to 64
--       characters (packages/schemas/customPages.ts PAGE_SLUG_PATTERN, CUSTOM_PAGE_SLUG_MAX);
--       23514 pages_slug_shape;
--     • a reserved word refused: every top-level route file of src/pages that is not a CMS page,
--       every top-level folder of public/, Cloudflare's own path and the language prefixes
--       (customPages.ts RESERVED_PAGE_SLUGS; tests/lib/customPages.spec.ts holds this literal
--       equal to the list and the list to the two directories); 23514 pages_slug_reserved.
--   The seven route slugs are not refused: the unique key refuses one while its page exists,
--   and a missing route page recreated (a release's restore) is that route's page again. 0057's
--   pages_route_slug_fixed still keeps them, and any page with a visibility row, from moving.
--   Plain words in the message; the constraint name rides the error so the Worker puts it on
--   the address field (src/lib/admin/resources/pages.ts constraintFields).
--
-- Nothing else changes. Who creates, edits, publishes, archives and deletes a custom page is
-- the table's existing RLS, the same as for every page: pages_write (Admin and Content Creator,
-- app.can_write_content), pages_archive_admin and pages_delete_admin (Admin, RESTRICTIVE),
-- pages_read (published, or staff). Its sections are page_sections rows under their own RLS
-- (0016's anon fence: a visible section of a published page). The release registry's page row
-- (0038) and page_section row (0115) already stage both, and R7 already purges `page:<slug>`.
-- No grant, policy, column or registry row is added, so both Supabase privilege regimes
-- (README P-14) read the same; the postconditions below check that nothing moved.
--
-- Rule 5 (the deployed Worker between this push and the deploy): no reader's shape changes.
-- The deployed Worker creates a page only through the legacy create form, whose slug field is
-- SlugSchema (1 to 120, the same pattern): a slug of 65 to 120 characters or a reserved word it
-- would have accepted is now a 23514, which its error mapping answers as a 422 on the form.
-- No production page is touched: the trigger fires on a write that sets a slug, never on the
-- rows already stored (the production read-back lists any stored slug the rule would refuse).
--
-- Production as of 2026-11-02: PostgreSQL 17.6, one tenant; main holds every migration through
-- 0120 (E4); E12 holds 0121 and E6 0122 in parallel, neither touching public.pages. Releases
-- stay off (app.release_tenants empty). CLAUDE.md §3 (Pillar 1), §8 (Data model; Admin v2
-- lanes, UI), §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it: creating a trigger on pages takes
-- a SHARE ROW EXCLUSIVE lock. A wait over five seconds raises, the migration rolls back whole,
-- and the push is retried later. Transaction-local: it ends with this migration.
set local lock_timeout = '5s';

-- ═══ 1. The rule ═══════════════════════════════════════════════════════════════════════════
-- Invoker, with an empty search path and qualified names only: it reads nothing but the row.
create or replace function app.tg_pages_slug_rules() returns trigger
  language plpgsql set search_path = ''
as $$
declare
  v_slug text := new.slug::text;
begin
  if tg_op = 'UPDATE' and v_slug is not distinct from old.slug::text then
    return new;
  end if;
  if v_slug is null
     or pg_catalog.char_length(v_slug) not between 1 and 64
     or v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'A page''s address uses lowercase letters, digits and single hyphens, at most 64 characters.'
      using errcode = '23514', constraint = 'pages_slug_shape',
            detail = 'Failing row violates check constraint "pages_slug_shape".';
  end if;
  if v_slug = any (array['404', 'admin', 'api', 'ar', 'cookie-policy', 'creative-knowledge',
                         'healthz', 'index', 'llms', 'manifest', 'privacy', 'robots', 'search',
                         'sitemap', 'styles', 'terms', 'fonts', 'media', 'og', 'scripts',
                         'cdn-cgi', 'en', 'www', 'assets', 'static', 'feed', 'rss',
                         'preview']) then
    raise exception 'The site already uses this address. Choose another one.'
      using errcode = '23514', constraint = 'pages_slug_reserved',
            detail = 'Failing row violates check constraint "pages_slug_reserved".';
  end if;
  return new;
end $$;
revoke all on function app.tg_pages_slug_rules() from public, anon, authenticated, service_role;

comment on function app.tg_pages_slug_rules() is
  'Admin v2 E11: a page''s address on insert or rename, for every writer: lowercase kebab-case, 1 to 64 characters (pages_slug_shape), never a word the site already answers (pages_slug_reserved). The list equals packages/schemas/customPages.ts RESERVED_PAGE_SLUGS.';

drop trigger if exists pages_slug_rules on public.pages;
create trigger pages_slug_rules before insert or update of slug on public.pages
  for each row execute function app.tg_pages_slug_rules();

-- ═══ 2. Postconditions ════════════════════════════════════════════════════════════════════
do $$
declare
  v_got text[];
  r text;
begin
  -- ---- 1. the trigger: before insert or update of slug, row level, enabled ---------------
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.pages'::regclass and t.tgname = 'pages_slug_rules'
       and not t.tgisinternal and t.tgenabled = 'O'
       and t.tgfoid = 'app.tg_pages_slug_rules()'::regprocedure
       -- ROW (1) | BEFORE (2) | INSERT (4) | UPDATE (16) = 23, UPDATE OF one column.
       and t.tgtype = 23
       and pg_catalog.array_length(t.tgattr::int2[], 1) = 1
       and (select a.attname from pg_attribute a
             where a.attrelid = t.tgrelid and a.attnum = t.tgattr[0]) = 'slug') then
    raise exception 'E11: pages_slug_rules must fire BEFORE INSERT OR UPDATE OF slug, per row';
  end if;

  -- ---- 2. the function: invoker, search path pinned, no API role executes it -------------
  if not exists (select 1 from pg_proc p
                  where p.oid = 'app.tg_pages_slug_rules()'::regprocedure
                    and not p.prosecdef
                    and p.proconfig = array['search_path=""']) then
    raise exception 'E11: app.tg_pages_slug_rules must be SECURITY INVOKER with search_path pinned';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'app.tg_pages_slug_rules()', 'execute') then
      raise exception 'E11: % may execute app.tg_pages_slug_rules()', r;
    end if;
  end loop;

  -- ---- 3. nothing else moved: pages' policies, RLS and the registry row ------------------
  select array_agg(polname::text order by polname) into v_got
    from pg_policy where polrelid = 'public.pages'::regclass;
  if v_got is distinct from array['pages_archive_admin', 'pages_delete_admin', 'pages_read',
                                  'pages_write'] then
    raise exception 'E11: public.pages policies are %', v_got;
  end if;
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.pages'::regclass) then
    raise exception 'E11: public.pages is not ENABLE + FORCE row level security';
  end if;
  if not exists (select 1 from app.release_entities
                  where entity_type = 'page' and table_name = 'pages') then
    raise exception 'E11: the release registry has no page row';
  end if;
  if exists (select 1 from app.release_tenants) then
    raise exception 'E11: releases must stay off (app.release_tenants is not empty)';
  end if;

  -- ---- 4. anon still writes no page; staff hold what 0011 gave them ----------------------
  if has_table_privilege('anon', 'public.pages', 'insert')
     or has_table_privilege('anon', 'public.pages', 'update')
     or has_table_privilege('anon', 'public.pages', 'delete') then
    raise exception 'E11: anon may write public.pages';
  end if;
end $$;
