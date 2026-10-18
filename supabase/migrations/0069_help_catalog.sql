-- ─────────────────────────────────────────────────────────────────────────────
-- 0069 — The help-guide catalog: one row per guide instead of one restated JSON set (Admin
-- v2 H11). Forward-only, expand only. Depends on 0046 (the help centre: public.help_articles,
-- its CHECK helpers app.help_text_ok, app.help_keys_ok and app.help_body_ok,
-- app.help_article_set(), app.seed_help_articles() and the tenants trigger) and on the last
-- migration that restated app.help_article_set() before this one (0065 on main today; G2's
-- 0067 and C4c's 0068 if they are pushed first). It restates no guide: the catalog is filled
-- from the set as the database holds it when this runs, so it is right after any of them.
--
-- Until now app.help_article_set() was one JSON literal, and every slice that added or edited
-- a guide restated the whole set (0046, 0052, 0054, 0055, 0056, 0057, 0060, 0061, 0064, 0065).
-- A slice built from an older set silently reverted a sibling's guide unless it was re-based
-- before every push. From here on a guide is a row:
--
--   • app.help_guide_catalog: one row per guide (slug, sort_order, minutes, tags, screens,
--     caps, title, title_ar, body), the fields the set carries, held by the same CHECKs as
--     public.help_articles (app.help_text_ok, app.help_keys_ok, app.help_body_ok), the slug
--     the key and the place in the list unique. Global, like app.release_entities (0038): the
--     admin's own help text, the same for every tenant, so it has no tenant_id; each tenant's
--     copy is its public.help_articles rows, tenant-scoped as before. RLS enabled and forced
--     with no policy, and no API role holds any privilege on it: the migration role (postgres,
--     BYPASSRLS) and the definer seed read it, nobody else.
--   • app.help_article_set() keeps its name, signature, grants and output: the same JSON array,
--     guide by guide, in the same order (sort_order, then slug), now read from the catalog. It
--     is STABLE instead of IMMUTABLE because it reads a table. app.seed_help_articles(), the
--     tenants trigger and every caller and test keep working unchanged.
--   • Each catalog row carries a `revision`: 1 as this migration fills it, moved by one each
--     time a put changes the guide. A slice names the revision it wrote its text against, so
--     two slices that edit one guide cannot silently overwrite each other (what
--     scratchpad/hs_rebase.py refused before): the one that lands second is refused at the
--     push (55000) and in CI (tests/fixtures/helpSet.ts), and re-bases its text on the first.
--   • app.put_help_guide(p_guide jsonb, p_revision int): a migration's one way to add or
--     change a guide (p_revision 0 for a new one). The guide is exactly the nine keys, each of
--     its type; the catalog's CHECKs then hold it to the rules help_articles holds (22023 for
--     a shape, 23514 for a rule, 23505 for a place another guide holds, 55000 for a stale
--     revision). It upserts that one catalog row and re-seeds that one slug into every
--     tenant: inserted where a tenant lacks it, brought to the catalog's text where it differs
--     (the guard moves its version once), and no other guide touched.
--   • app.drop_help_guide(p_slug text, p_revision int): retires a guide: its catalog row and
--     every tenant's copy. A slug the catalog does not hold is refused (P0002), so a typo
--     fails the push, and so is a stale revision (55000).
--
-- The rule (CLAUDE.md §8 U16, docs/admin-v2/migrations.md Rules): a slice adds or changes only
-- its own guide, with one top-level `select app.put_help_guide($guide$ {...} $guide$::jsonb, N);`
-- (or `select app.drop_help_guide('slug', N);`), N the guide's revision as main holds it (0 for
-- a new guide); nobody restates the set, and no later migration
-- replaces app.help_article_set() (tests/lib/helpCentre.spec.ts refuses both, and reads the
-- set as the last restatement before this file plus every later put and drop, in order).
--
-- Proof that nothing moved: the set's text is fingerprinted (md5 of its jsonb text) before the
-- function is replaced and compared after; every tenant is re-seeded (a no-op where it matches)
-- and must hold every guide exactly as the catalog has it.
--
-- P-14: everything is revoked from PUBLIC, anon, authenticated and service_role, and nothing is
-- granted; the postconditions check both regimes, table-wide and per column. No policy, no
-- capability (CLAUDE.md §5 is untouched), no change to public.help_articles or its grants.
-- CLAUDE.md §3 (Pillar 1), §8 (Admin v2 lanes, UI: U16).
-- ─────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing (as in 0038 to 0065): the re-seed writes
-- public.help_articles. A statement below that waits more than five seconds for a lock raises
-- instead, the whole migration rolls back, and the push is retried later. Transaction-local:
-- it ends with this migration.
set local lock_timeout = '5s';

-- ---- 1. The set as it stands, fingerprinted --------------------------------------------------
-- Kept in a session setting (not a temp table, which a statement-per-transaction runner would
-- drop at once) and cleared by the postconditions.
do $$
declare
  v_set jsonb := app.help_article_set();
begin
  if v_set is null or jsonb_typeof(v_set) <> 'array' or jsonb_array_length(v_set) < 1 then
    raise exception '0069: app.help_article_set() is not a non-empty array before the catalog';
  end if;
  perform pg_catalog.set_config('braiin.h11_set_before',
                                pg_catalog.md5(v_set::text) || ':' || jsonb_array_length(v_set),
                                false);
end $$;

-- ---- 2. The catalog --------------------------------------------------------------------------
create table if not exists app.help_guide_catalog (
  -- Lower case by its CHECK, so a text key is unique the way citext would make it (§8).
  slug text primary key,
  sort_order int not null,
  minutes smallint not null,
  tags text[] not null,
  screens text[] not null,
  caps text[] not null,
  title text not null,
  title_ar text not null,
  body jsonb not null,
  -- 1 as filled; one more each time a put changes the guide (app.put_help_guide).
  revision int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The list's order: two guides never share a place.
  constraint help_guide_catalog_sort_order unique (sort_order),
  -- The rules public.help_articles holds (0046), word for word.
  constraint help_guide_catalog_slug_shape check (
    char_length(slug) <= 64 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint help_guide_catalog_titles_ok check (
    app.help_text_ok(title, 120) and app.help_text_ok(title_ar, 120)),
  constraint help_guide_catalog_minutes_range check (minutes between 1 and 30),
  constraint help_guide_catalog_tags_ok check (app.help_keys_ok(tags, '^[a-z][a-z0-9-]{0,23}$', 6)),
  constraint help_guide_catalog_screens_ok check (
    cardinality(screens) >= 1 and app.help_keys_ok(screens, '^/admin(/[a-z0-9-]+)*$', 16)),
  constraint help_guide_catalog_caps_ok check (
    app.help_keys_ok(caps, '^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$', 12)),
  constraint help_guide_catalog_body_ok check (app.help_body_ok(body)),
  constraint help_guide_catalog_revision_positive check (revision >= 1)
);
alter table app.help_guide_catalog enable row level security;
alter table app.help_guide_catalog force row level security;
revoke all on app.help_guide_catalog from public, anon, authenticated, service_role;
comment on table app.help_guide_catalog is
  'The admin''s help guides, one row per guide (Admin v2 H11, 0069). Global (the same for '
  'every tenant; each tenant''s copy is public.help_articles). Written only by migrations, '
  'through app.put_help_guide and app.drop_help_guide; read by app.help_article_set().';

-- Filled from the set as it stands (the last restatement's text, whichever migration that is).
-- A second run finds every slug present and changes nothing.
insert into app.help_guide_catalog
  (slug, sort_order, minutes, tags, screens, caps, title, title_ar, body)
select a.slug, a.sort_order, a.minutes, a.tags, a.screens, a.caps, a.title, a.title_ar, a.body
  from jsonb_to_recordset(app.help_article_set())
    as a (slug text, sort_order int, minutes smallint, tags text[], screens text[], caps text[],
          title text, title_ar text, body jsonb)
on conflict (slug) do nothing;

-- ---- 3. The set, read from the catalog ------------------------------------------------------
-- The same array the literal was: one object per guide with the same nine keys (jsonb orders
-- an object's keys itself, so the text is the literal's), in sort_order (every restatement was
-- sorted so, hs_rebase.py included). STABLE: it reads a table. Invoker with an empty search
-- path, as before; no API role executes it (restated below).
create or replace function app.help_article_set() returns jsonb
  language sql stable set search_path = '' as $$
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'slug', c.slug, 'sort_order', c.sort_order, 'minutes', c.minutes,
               'tags', pg_catalog.to_jsonb(c.tags), 'screens', pg_catalog.to_jsonb(c.screens),
               'caps', pg_catalog.to_jsonb(c.caps), 'title', c.title, 'title_ar', c.title_ar,
               'body', c.body)
             order by c.sort_order, c.slug),
           '[]'::jsonb)
    from app.help_guide_catalog c
$$;

-- ---- 4. Adding, changing and retiring one guide ----------------------------------------------
-- For migrations, run as their role (postgres): invoker, never a definer, and no API role
-- executes either. p_revision is the guide's revision the migration was written against (0
-- for a guide the catalog does not hold); any other is refused (55000) before anything is
-- written, so a slice built on an older text of a guide a sibling has since changed fails
-- instead of reverting it. A guide is exactly the nine keys the set carries, each of its JSON
-- type (22023 otherwise, before anything is written); the catalog's CHECKs then refuse what
-- help_articles would (23514), and its unique place refuses a sort_order another guide holds
-- (23505). Then that one slug is re-seeded into every tenant, as app.seed_help_articles does
-- for the whole set: inserted, or brought to the catalog's text where it differs (the guard,
-- 0046, moves the version only then). No other guide is read or written.
create or replace function app.put_help_guide(p_guide jsonb, p_revision int) returns void
  language plpgsql set search_path = '' as $$
declare
  v_keys constant text[] := array['body', 'caps', 'minutes', 'screens', 'slug', 'sort_order',
                                  'tags', 'title', 'title_ar'];
  v_slug text;
  v_have int;
begin
  if p_guide is null or jsonb_typeof(p_guide) <> 'object'
     or (select array_agg(k order by k collate "C") from jsonb_object_keys(p_guide) k)
        is distinct from v_keys then
    raise exception using errcode = '22023',
      message = 'put_help_guide: a guide is exactly {slug, sort_order, minutes, tags, screens, caps, title, title_ar, body}';
  end if;
  if jsonb_typeof(p_guide -> 'slug') <> 'string'
     or jsonb_typeof(p_guide -> 'title') <> 'string'
     or jsonb_typeof(p_guide -> 'title_ar') <> 'string'
     or jsonb_typeof(p_guide -> 'body') <> 'object'
     -- Whole numbers only: 70, never 70.0 or "70". (7e1 is accepted: jsonb stores it as 70.)
     or jsonb_typeof(p_guide -> 'sort_order') <> 'number'
     or (p_guide ->> 'sort_order') !~ '^-?[0-9]{1,9}$'
     or jsonb_typeof(p_guide -> 'minutes') <> 'number'
     or (p_guide ->> 'minutes') !~ '^[0-9]{1,4}$'
     -- Lists of text: an array whose every item is a string (a number or an object is refused,
     -- never cast).
     or exists (select 1 from unnest(array['tags', 'screens', 'caps']) f
                 where jsonb_typeof(p_guide -> f) <> 'array'
                    or exists (select 1 from jsonb_array_elements(p_guide -> f) e
                                where jsonb_typeof(e) <> 'string')) then
    raise exception using errcode = '22023',
      message = 'put_help_guide: slug, title and title_ar are text, sort_order and minutes whole numbers, tags, screens and caps lists of text, body an object';
  end if;

  v_slug := p_guide ->> 'slug';
  select c.revision into v_have from app.help_guide_catalog c where c.slug = v_slug for update;
  if p_revision is null or p_revision is distinct from coalesce(v_have, 0) then
    raise exception using errcode = '55000',
      message = format('put_help_guide: %s is at revision %s in the catalog, the migration names %s',
                       v_slug, coalesce(v_have, 0), coalesce(p_revision::text, 'none')),
      hint = 'Merge main, write the guide on its current text, and name that revision (0 for a new guide).';
  end if;
  -- Lists keep the order they are written in (the CHECKs and the seed compare arrays whole).
  insert into app.help_guide_catalog as c
    (slug, sort_order, minutes, tags, screens, caps, title, title_ar, body)
  values (v_slug,
          (p_guide ->> 'sort_order')::int,
          (p_guide ->> 'minutes')::smallint,
          array(select e from jsonb_array_elements_text(p_guide -> 'tags') with ordinality as l(e, n)
                order by n),
          array(select e from jsonb_array_elements_text(p_guide -> 'screens') with ordinality as l(e, n)
                order by n),
          array(select e from jsonb_array_elements_text(p_guide -> 'caps') with ordinality as l(e, n)
                order by n),
          p_guide ->> 'title',
          p_guide ->> 'title_ar',
          p_guide -> 'body')
  on conflict (slug) do update
     set sort_order = excluded.sort_order, minutes = excluded.minutes, tags = excluded.tags,
         screens = excluded.screens, caps = excluded.caps, title = excluded.title,
         title_ar = excluded.title_ar, body = excluded.body, revision = c.revision + 1,
         updated_at = now()
   where row(c.sort_order, c.minutes, c.tags, c.screens, c.caps, c.title, c.title_ar, c.body)
         is distinct from row(excluded.sort_order, excluded.minutes, excluded.tags,
                              excluded.screens, excluded.caps, excluded.title,
                              excluded.title_ar, excluded.body);

  insert into public.help_articles as h
    (tenant_id, slug, title, title_ar, minutes, tags, screens, caps, body, sort_order)
  select t.id, c.slug, c.title, c.title_ar, c.minutes, c.tags, c.screens, c.caps, c.body,
         c.sort_order
    from public.tenants t
   cross join app.help_guide_catalog c
   where c.slug = v_slug
  on conflict (tenant_id, slug) do update
     set title = excluded.title, title_ar = excluded.title_ar, minutes = excluded.minutes,
         tags = excluded.tags, screens = excluded.screens, caps = excluded.caps,
         body = excluded.body, sort_order = excluded.sort_order
   where row(h.title, h.title_ar, h.minutes, h.tags, h.screens, h.caps, h.body, h.sort_order)
         is distinct from row(excluded.title, excluded.title_ar, excluded.minutes,
                              excluded.tags, excluded.screens, excluded.caps, excluded.body,
                              excluded.sort_order);
end $$;

create or replace function app.drop_help_guide(p_slug text, p_revision int) returns void
  language plpgsql set search_path = '' as $$
declare
  v_have int;
begin
  select c.revision into v_have from app.help_guide_catalog c where c.slug = p_slug for update;
  if not found then
    raise exception using errcode = 'P0002',
      message = format('drop_help_guide: the catalog holds no guide %L', p_slug);
  end if;
  if p_revision is distinct from v_have then
    raise exception using errcode = '55000',
      message = format('drop_help_guide: %s is at revision %s in the catalog, the migration names %s',
                       p_slug, v_have, coalesce(p_revision::text, 'none')),
      hint = 'Merge main: a sibling changed the guide since this migration was written.';
  end if;
  delete from app.help_guide_catalog where slug = p_slug;
  delete from public.help_articles where slug = p_slug;
end $$;

-- ---- 5. Grants, stated (Admin v2 P-14: both Supabase grant regimes) -----------------------
-- No API role reads the catalog or calls any of the three; the migrations (postgres) and the
-- definer seed (owned by postgres) need no grant.
revoke all on function app.help_article_set() from public, anon, authenticated, service_role;
revoke all on function app.put_help_guide(jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function app.drop_help_guide(text, integer) from public, anon, authenticated, service_role;

-- ---- 6. Every tenant holds the set ---------------------------------------------------------
-- A no-op where a tenant already matches (the seed updates only what differs); it restores a
-- guide an operator edited by hand, as every restatement's re-seed did.
do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform app.seed_help_articles(t.id);
  end loop;
end $$;

-- ---- Postconditions ---------------------------------------------------------------------
-- Each block says what it checks. Expressions are read as the catalog prints them, the same on
-- PostgreSQL 15 and 17.
do $$
declare
  -- Every table privilege the server knows. MAINTAIN exists from PostgreSQL 17 (production
  -- runs 17.6, CI 15), and the privilege functions refuse the word on an older server.
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger']
    || case when current_setting('server_version_num')::int >= 170000
            then array['maintain'] else array[]::text[] end;
  v_before text := pg_catalog.current_setting('braiin.h11_set_before', true);
  v_set jsonb := app.help_article_set();
  v_have text[];
  v_want text[];
  v_bad text;
  v_n int;
  p text;
begin
  -- ---- The set did not move: the same text, byte for byte, as the literal it replaced.
  if v_before is null or v_before = ''
     or v_before is distinct from pg_catalog.md5(v_set::text) || ':' || jsonb_array_length(v_set) then
    raise exception '0069: app.help_article_set() changed: before %, after %', v_before,
      pg_catalog.md5(v_set::text) || ':' || jsonb_array_length(v_set);
  end if;
  perform pg_catalog.set_config('braiin.h11_set_before', '', false);
  if (select count(*) from app.help_guide_catalog) <> jsonb_array_length(v_set) then
    raise exception '0069: the catalog and the set disagree on how many guides there are';
  end if;

  -- ---- The catalog: RLS on and forced, no policy at all.
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'app.help_guide_catalog'::regclass) then
    raise exception '0069: app.help_guide_catalog is not ENABLE + FORCE row level security';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'app' and tablename = 'help_guide_catalog') then
    raise exception '0069: app.help_guide_catalog has a policy (it must have none)';
  end if;

  -- ---- No API role holds any table privilege on it, directly or through a role it is a
  -- member of.
  select string_agg(format('%s %s', w.who, pr.priv), ', ' order by w.who, pr.priv) into v_bad
    from unnest(array['public', 'anon', 'authenticated', 'service_role']) as w(who)
    cross join unnest(v_privs) as pr(priv)
   where has_table_privilege(w.who::name, 'app.help_guide_catalog', pr.priv);
  if v_bad is not null then
    raise exception '0069: an API role holds a privilege on app.help_guide_catalog: %', v_bad;
  end if;
  -- ---- Its own ACL holds the owner's entry alone, and no column carries a grant.
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s',
                        case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end,
                        lower(a.privilege_type)) as e
            from pg_class c
            cross join lateral aclexplode(c.relacl) a
           where c.oid = 'app.help_guide_catalog'::regclass
             and a.grantee <> c.relowner) s;
  if v_have <> '{}'::text[] then
    raise exception '0069: app.help_guide_catalog is granted %', v_have;
  end if;
  if exists (select 1 from pg_attribute att
               where att.attrelid = 'app.help_guide_catalog'::regclass
                 and att.attnum > 0 and not att.attisdropped and att.attacl is not null
                 and cardinality(att.attacl) > 0) then
    raise exception '0069: app.help_guide_catalog has a column grant';
  end if;
  foreach p in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_any_column_privilege(p::name, 'app.help_guide_catalog', 'select, insert, update, references') then
      raise exception '0069: % holds a column privilege on app.help_guide_catalog', p;
    end if;
  end loop;

  -- ---- Its keys and rules: the slug the key, the place unique, every CHECK help_articles
  -- has; no foreign key (it is global), no sequence.
  select coalesce(array_agg(format('%s %s', conname, contype::text) order by conname::text), '{}')
    into v_have
    from pg_constraint
   where conrelid = 'app.help_guide_catalog'::regclass and contype::text <> 'n';
  v_want := array['help_guide_catalog_body_ok c', 'help_guide_catalog_caps_ok c',
                  'help_guide_catalog_minutes_range c', 'help_guide_catalog_pkey p',
                  'help_guide_catalog_revision_positive c',
                  'help_guide_catalog_screens_ok c', 'help_guide_catalog_slug_shape c',
                  'help_guide_catalog_sort_order u', 'help_guide_catalog_tags_ok c',
                  'help_guide_catalog_titles_ok c'];
  if v_have is distinct from v_want then
    raise exception '0069: app.help_guide_catalog constraints are %, expected %', v_have, v_want;
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = 'app.help_guide_catalog'::regclass and conname = 'help_guide_catalog_pkey')
       <> 'PRIMARY KEY (slug)'
     or (select pg_get_constraintdef(oid) from pg_constraint
          where conrelid = 'app.help_guide_catalog'::regclass
            and conname = 'help_guide_catalog_sort_order') <> 'UNIQUE (sort_order)' then
    raise exception '0069: the catalog must be keyed by slug with one guide per place';
  end if;

  -- ---- The functions: no API role executes any of them; each an invoker with an empty
  -- search path; the set STABLE (it reads a table).
  foreach p in array array['app.help_article_set()', 'app.put_help_guide(jsonb, integer)',
                           'app.drop_help_guide(text, integer)', 'app.seed_help_articles(uuid)'] loop
    if has_function_privilege('public', p, 'execute')
       or has_function_privilege('anon', p, 'execute')
       or has_function_privilege('authenticated', p, 'execute')
       or has_function_privilege('service_role', p, 'execute') then
      raise exception '0069: % is executable by an API role', p;
    end if;
  end loop;
  foreach p in array array['app.help_article_set()', 'app.put_help_guide(jsonb, integer)',
                           'app.drop_help_guide(text, integer)'] loop
    if not exists (select 1 from pg_proc
                    where oid = p::regprocedure and not prosecdef
                      and exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c
                                   where c in ('search_path=""', 'search_path='))) then
      raise exception '0069: % must be SECURITY INVOKER with an empty search_path', p;
    end if;
  end loop;
  if (select provolatile::text from pg_proc where oid = 'app.help_article_set()'::regprocedure) <> 's' then
    raise exception '0069: app.help_article_set() must be STABLE';
  end if;

  -- ---- The helper refuses a bad shape before writing anything (each case in its own
  -- subtransaction: a refusal is caught here, anything else fails the push).
  foreach p in array array[
      'null',
      '[]',
      '{"slug": "x"}',
      -- One key too many.
      '{"slug": "x", "sort_order": 1, "minutes": 1, "tags": [], "screens": ["/admin"], "caps": [], "title": "X", "title_ar": "س", "body": {"en": [{"t": "p", "x": "a"}], "ar": [{"t": "p", "x": "ب"}]}, "extra": 1}',
      -- A number where a list of text belongs.
      '{"slug": "x", "sort_order": 1, "minutes": 1, "tags": [1], "screens": ["/admin"], "caps": [], "title": "X", "title_ar": "س", "body": {"en": [{"t": "p", "x": "a"}], "ar": [{"t": "p", "x": "ب"}]}}',
      -- A place that is not a whole number.
      '{"slug": "x", "sort_order": 1.5, "minutes": 1, "tags": [], "screens": ["/admin"], "caps": [], "title": "X", "title_ar": "س", "body": {"en": [{"t": "p", "x": "a"}], "ar": [{"t": "p", "x": "ب"}]}}'] loop
    begin
      perform app.put_help_guide(p::jsonb, 0);
      raise exception '0069: app.put_help_guide accepted %', p;
    exception when sqlstate '22023' then
      null;
    end;
  end loop;
  begin
    perform app.put_help_guide('{"slug": "x", "sort_order": 1, "minutes": 1, "tags": [], "screens": ["/admin"], "caps": [], "title": "<b>X</b>", "title_ar": "س", "body": {"en": [{"t": "p", "x": "a"}], "ar": [{"t": "p", "x": "ب"}]}}'::jsonb, 0);
    raise exception '0069: app.put_help_guide accepted markup in a title';
  exception when check_violation then
    null;
  end;
  begin
    perform app.drop_help_guide('no-such-guide-0069', 1);
    raise exception '0069: app.drop_help_guide accepted a slug the catalog does not hold';
  exception when no_data_found then
    null;
  end;
  -- A stale revision: putting or dropping a guide named at a revision it is not at.
  begin
    perform app.put_help_guide(app.help_article_set() -> 0, 0);
    raise exception '0069: app.put_help_guide accepted a stale revision';
  exception when object_not_in_prerequisite_state then
    null;
  end;
  begin
    perform app.drop_help_guide(app.help_article_set() -> 0 ->> 'slug', 2);
    raise exception '0069: app.drop_help_guide accepted a stale revision';
  exception when object_not_in_prerequisite_state then
    null;
  end;
  if exists (select 1 from app.help_guide_catalog where slug = 'x')
     or exists (select 1 from app.help_guide_catalog where revision <> 1) then
    raise exception '0069: a refused guide reached the catalog';
  end if;

  -- ---- Every tenant holds every guide exactly as the catalog has it (a guide an operator
  -- added by hand, which the catalog does not hold, is left alone, as the seed leaves it).
  select count(*)::int into v_n
    from public.tenants t
    cross join app.help_guide_catalog c
   where not exists (select 1 from public.help_articles h
                      where h.tenant_id = t.id and h.slug = c.slug and h.title = c.title
                        and h.title_ar = c.title_ar and h.minutes = c.minutes
                        and h.tags = c.tags and h.screens = c.screens and h.caps = c.caps
                        and h.body = c.body and h.sort_order = c.sort_order);
  if v_n > 0 then
    raise exception '0069: % tenant guide(s) differ from the catalog', v_n;
  end if;
end $$;
