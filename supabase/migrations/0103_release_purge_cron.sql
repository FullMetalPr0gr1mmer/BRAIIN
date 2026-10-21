-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0103_release_purge_cron.sql — Releases, the cache purge and the minute cron (Admin v2 R7).
-- Forward-only, expand only, inert while releases are off (app.release_tenants is empty until
-- R14) and while no cache zone is set up (owner item O-3). Its number is assigned at merge
-- (scripts/renumber-migration.mjs). Depends on 0001 (tenants, app.is_staff,
-- app.effective_tenant_id), 0038 (content_releases, app.release_entities) and 0051
-- (record_release_purge, the release's purge columns).
--
-- What this file adds (docs/admin-v2/releases.md §5, slice R7; the departures are in
-- docs/admin-v2/as-built/R7.md):
--   1. public.cache_purge_log: one row per purge request the Worker sends to the cache (a
--      release's, the minute cron's retry, a media save's `media:all`): when, how many tags,
--      from where. It is the 24-hour budget's ledger (CLAUDE.md §2: at most 30 tags a purge
--      and 30,000 a day), counted across the deployment (one zone), so it holds across
--      isolates. Rows older than 48 hours are dropped by the function below. No person reads
--      or writes it: RLS forced with no policy, and only the service role holds privileges.
--   2. public.cache_purge_take(tenant, tags, source): the service role asks before each purge
--      request; true and a ledger row when the last 24 hours plus these tags stay within
--      30,000, false (nothing written) otherwise. Serialised by a transaction advisory lock,
--      so two isolates cannot both take the last of the budget.
--   3. public.claim_release_purges(limit): the minute cron's claim. Published releases whose
--      purge failed and is due again (`purge_next_at` reached, fewer than 10 attempts), and
--      releases whose after-effects never ran (still `pending` with no attempt two minutes
--      after they went live: the Worker stopped after the commit), oldest first, locked with
--      SKIP LOCKED and pushed five minutes ahead in the same statement: one claim per
--      release, so two runs of the cron never act on the same release twice. The Worker then
--      records the outcome with record_release_purge (0051), which counts the attempt.
--   4. public.release_read_rows(tenant, reads): Admin v2 O-16. A publish's check reads the
--      live rows the selection changes and every row its links name, one PostgREST request
--      per table: a release touching every registry type cost 42 requests before its rules
--      ran, past the Workers Free plan's 50 once the session, the apply and the after-effects
--      were added. This answers up to 40 reads of up to 500 rows each in ONE request, as the
--      caller: SECURITY INVOKER, so RLS, the RESTRICTIVE gates and the column grants bind
--      exactly as a PostgREST read of the same table would. CMS staff only, the token's own
--      tenant only, only registry tables and media_assets, only columns the table has (each
--      quoted with %I), keyed by `id` or `tenant_id` with the values bound as uuid[].
--
-- No capability, no app.role_* helper, no registry row, no screen and no guide: the purge
-- and the cron are the system's, and the read gives staff nothing PostgREST does not.
--
-- CLAUDE.md §8's row shape is departed from for the ledger as for content_release_items: an
-- append-only record the system writes (no updated_at, no actor columns, no version); the
-- tenant column, RLS ENABLE + FORCE and the stated grants stay.
--
-- Grants are stated for both Supabase privilege regimes (README P-14): revoke from PUBLIC,
-- anon, authenticated and the service role, then grant exactly. Postconditions at the end.
-- CLAUDE.md §2 (the Cache-Tag limits), §3 (Pillars 1 and 4), §8, §10.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing: a statement below that waits more than
-- five seconds for a lock raises, and the push is retried later. Transaction-local.
set local lock_timeout = '5s';

-- ═══ 1. The purge ledger ═════════════════════════════════════════════════════════════════
create table if not exists public.cache_purge_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  created_at timestamptz not null default pg_catalog.now(),
  -- The tags one request purges: at most 30 (CLAUDE.md §2).
  tag_count int not null,
  -- Who sent it: a publish's after-effects, the minute cron's retry, a media save.
  source text not null,
  constraint cache_purge_log_tag_count check (tag_count between 1 and 30),
  constraint cache_purge_log_source check (source in ('release', 'cron', 'media'))
);
create index if not exists cache_purge_log_created_idx on public.cache_purge_log (created_at);
alter table public.cache_purge_log enable row level security;
alter table public.cache_purge_log force row level security;

-- No policy: no API role reads or writes it through RLS. The service role (BYPASSRLS on
-- Supabase) writes and reads it through cache_purge_take.
revoke all on public.cache_purge_log from public, anon, authenticated, service_role;
grant select, insert, delete on public.cache_purge_log to service_role;
comment on table public.cache_purge_log is
  'One row per cache purge request (Admin v2 R7, 0103): the 24-hour tag budget''s ledger. '
  'Written and pruned by public.cache_purge_take; no API role but the service role holds a '
  'privilege.';

-- ═══ 2. The budget ═══════════════════════════════════════════════════════════════════════
-- CACHE_PURGE_DAY_TAGS and CACHE_PURGE_MAX_TAGS in src/lib/http/purge.ts
-- (tests/lib/purge.spec.ts holds them equal to the literals here).
create or replace function public.cache_purge_take(p_tenant uuid, p_tags int, p_source text)
  returns boolean
  language plpgsql volatile security invoker set search_path = '' set lock_timeout = '5s'
as $$
declare
  v_used bigint;
begin
  if current_user::text <> 'service_role' then
    raise exception 'cache_purge_take: only the service role purges the cache' using errcode = '42501';
  end if;
  if p_tenant is null or p_tags is null or p_tags < 1 or p_tags > 30
     or p_source is null or p_source not in ('release', 'cron', 'media') then
    raise exception 'cache_purge_take: a tenant, 1 to 30 tags and a source (release, cron or media)'
      using errcode = '22023';
  end if;
  -- One taker at a time across the deployment: the budget is the zone's, not a tenant's.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cache_purge_budget', 0));
  delete from public.cache_purge_log l where l.created_at < pg_catalog.now() - interval '48 hours';
  select coalesce(sum(l.tag_count), 0) into v_used
    from public.cache_purge_log l
   where l.created_at > pg_catalog.now() - interval '24 hours';
  if v_used + p_tags > 30000 then
    return false;
  end if;
  insert into public.cache_purge_log (tenant_id, tag_count, source)
  values (p_tenant, p_tags, p_source);
  return true;
end $$;
revoke all on function public.cache_purge_take(uuid, int, text)
  from public, anon, authenticated, service_role;
grant execute on function public.cache_purge_take(uuid, int, text) to service_role;

-- ═══ 3. The minute cron's claim ══════════════════════════════════════════════════════════
-- RELEASE_PURGE_MAX_ATTEMPTS, RELEASE_ORPHAN_AFTER_MINUTES and RELEASE_CLAIM_LEASE_MINUTES in
-- src/lib/cron/releases.ts (tests/lib/releaseCron.spec.ts holds them equal to the literals).
-- An answer row: {tenant_id, release_id, number, tags, status, attempts, orphan}; `orphan` is
-- a release whose after-effects never ran (the snapshots and the purge are owed).
create or replace function public.claim_release_purges(p_limit int default 5)
  returns jsonb
  language plpgsql volatile security invoker set search_path = '' set lock_timeout = '5s'
as $$
declare
  v_out jsonb;
begin
  if current_user::text <> 'service_role' then
    raise exception 'claim_release_purges: only the service role claims' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'claim_release_purges: a limit of 1 to 20' using errcode = '22023';
  end if;
  with due as (
    select r.id
      from public.content_releases r
     where r.status = 'published'
       and r.purge_status in ('pending', 'failed')
       and r.purge_attempts < 10
       and coalesce(r.purge_next_at, r.published_at + interval '2 minutes') <= pg_catalog.now()
     order by coalesce(r.purge_next_at, r.published_at), r.id
     limit p_limit
       for update of r skip locked
  ), claimed as (
    update public.content_releases r
       set purge_next_at = pg_catalog.now() + interval '5 minutes'
      from due
     where r.id = due.id
    returning r.tenant_id, r.id, r.number, r.tags, r.purge_status, r.purge_attempts,
              coalesce(r.published_at, r.created_at) as at
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'tenant_id', c.tenant_id, 'release_id', c.id, 'number', c.number, 'tags', c.tags,
           'status', c.purge_status, 'attempts', c.purge_attempts,
           'orphan', c.purge_status = 'pending' and c.purge_attempts = 0)
           order by c.at, c.id), '[]'::jsonb)
    into v_out
    from claimed c;
  return v_out;
end $$;
revoke all on function public.claim_release_purges(int)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_release_purges(int) to service_role;

-- ═══ 4. One read for a publish's check (O-16) ════════════════════════════════════════════
-- p_reads: 1 to 40 objects, each exactly {table, columns, key, ids}: `table` a registry table
-- (app.release_entities, read as the caller: CMS staff read it, 0038) or media_assets;
-- `columns` 1 to 200 column names of that table, or ["*"]; `key` 'id' or 'tenant_id' (a
-- singleton's key); `ids` 1 to 500 uuids. Answers an array with one array of rows per read,
-- in order, each row as to_jsonb prints it (the shape PostgREST answers). Nothing is
-- spliced but %I-quoted names the catalog confirmed; the tenant and the ids are bound.
-- RELEASE_READS_MAX and RELEASE_READ_IDS_MAX in src/lib/release/overlayDb.ts
-- (tests/lib/overlayDb.spec.ts holds them equal to the literals here).
create or replace function public.release_read_rows(p_tenant uuid, p_reads jsonb)
  returns jsonb
  language plpgsql stable security invoker set search_path = ''
as $$
declare
  c_name constant text := '^[a-z_][a-z0-9_]{0,62}$';
  v_read jsonb;
  v_table text;
  v_key text;
  v_cols jsonb;
  v_ids uuid[];
  v_list text;
  v_rel oid;
  v_bad text;
  v_rows jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  -- Who: CMS staff (the four roles), reading their own tenant. RLS binds below as well.
  if not app.is_staff() then
    raise exception 'release_read_rows: CMS staff only' using errcode = '42501';
  end if;
  if p_tenant is null or p_tenant is distinct from app.effective_tenant_id() then
    raise exception 'release_read_rows: your own site only' using errcode = '42501';
  end if;
  if p_reads is null or pg_catalog.jsonb_typeof(p_reads) is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_reads) < 1 or pg_catalog.jsonb_array_length(p_reads) > 40 then
    raise exception 'release_read_rows: 1 to 40 reads' using errcode = '22023';
  end if;

  for v_read in select e.value from pg_catalog.jsonb_array_elements(p_reads) with ordinality as e
                 order by e.ordinality loop
    if pg_catalog.jsonb_typeof(v_read) is distinct from 'object'
       or (select pg_catalog.array_agg(k order by k collate "C")
             from pg_catalog.jsonb_object_keys(v_read) k)
          is distinct from array['columns', 'ids', 'key', 'table'] then
      raise exception 'release_read_rows: a read is exactly {table, columns, key, ids}'
        using errcode = '22023';
    end if;
    v_table := v_read ->> 'table';
    v_key := v_read ->> 'key';
    v_cols := v_read -> 'columns';

    -- The table: a registry table or media_assets, in public.
    if v_table is null or v_table !~ c_name
       or not (v_table = 'media_assets'
               or exists (select 1 from app.release_entities e where e.table_name = v_table)) then
      raise exception 'release_read_rows: not a table this read serves' using errcode = '22023';
    end if;
    select c.oid into v_rel
      from pg_catalog.pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relname = v_table and c.relkind = 'r';
    if v_rel is null then
      raise exception 'release_read_rows: not a table this read serves' using errcode = '22023';
    end if;

    -- The key: id or tenant_id, a column of the table.
    if v_key is null or v_key not in ('id', 'tenant_id')
       or not exists (select 1 from pg_catalog.pg_attribute a
                       where a.attrelid = v_rel and a.attname = v_key
                         and a.attnum > 0 and not a.attisdropped) then
      raise exception 'release_read_rows: the key is id or tenant_id' using errcode = '22023';
    end if;

    -- The ids: 1 to 500 uuids, bound as uuid[].
    if pg_catalog.jsonb_typeof(v_read -> 'ids') is distinct from 'array'
       or pg_catalog.jsonb_array_length(v_read -> 'ids') < 1
       or pg_catalog.jsonb_array_length(v_read -> 'ids') > 500
       or exists (select 1 from pg_catalog.jsonb_array_elements(v_read -> 'ids') x
                   where pg_catalog.jsonb_typeof(x) is distinct from 'string'
                      or (x #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'release_read_rows: ids are 1 to 500 uuids' using errcode = '22023';
    end if;
    v_ids := array(select (x #>> '{}')::uuid from pg_catalog.jsonb_array_elements(v_read -> 'ids') x);

    -- The columns: ["*"], or 1 to 200 names the table has, each quoted with %I.
    if pg_catalog.jsonb_typeof(v_cols) is distinct from 'array'
       or pg_catalog.jsonb_array_length(v_cols) < 1 or pg_catalog.jsonb_array_length(v_cols) > 200 then
      raise exception 'release_read_rows: columns are ["*"] or 1 to 200 names' using errcode = '22023';
    end if;
    if v_cols = '["*"]'::jsonb then
      v_list := 't.*';
    else
      select pg_catalog.string_agg(x #>> '{}', ', ' order by o) into v_bad
        from pg_catalog.jsonb_array_elements(v_cols) with ordinality as e(x, o)
       where pg_catalog.jsonb_typeof(x) is distinct from 'string'
          or (x #>> '{}') !~ c_name
          or not exists (select 1 from pg_catalog.pg_attribute a
                          where a.attrelid = v_rel and a.attname = (x #>> '{}')
                            and a.attnum > 0 and not a.attisdropped);
      if v_bad is not null or exists (select 1 from pg_catalog.jsonb_array_elements(v_cols) x
                                       where pg_catalog.jsonb_typeof(x) is distinct from 'string') then
        raise exception 'release_read_rows: a column this table does not have' using errcode = '22023';
      end if;
      select pg_catalog.string_agg(pg_catalog.format('t.%I', n), ', ' order by o) into v_list
        from (select distinct on (x #>> '{}') x #>> '{}' as n, o
                from pg_catalog.jsonb_array_elements(v_cols) with ordinality as e(x, o)
               order by x #>> '{}', o) d;
    end if;

    execute pg_catalog.format(
      'select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r)), ''[]''::jsonb) '
      'from (select %s from public.%I t where t.tenant_id = $1 and t.%I = any ($2)) r',
      v_list, v_table, v_key)
      into v_rows using p_tenant, v_ids;
    v_out := v_out || pg_catalog.jsonb_build_array(v_rows);
  end loop;
  return v_out;
end $$;
revoke all on function public.release_read_rows(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.release_read_rows(uuid, jsonb) to authenticated;

-- ═══ Postconditions ═════════════════════════════════════════════════════════════════════
-- Each block says what it checks.
do $$
declare
  -- Every table privilege the server knows. MAINTAIN exists from PostgreSQL 17 (production
  -- runs 17.6, CI 15), and the privilege functions refuse the word on an older server.
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger']
    || case when current_setting('server_version_num')::int >= 170000
            then array['maintain'] else array[]::text[] end;
  v_take constant text := 'public.cache_purge_take(uuid, integer, text)';
  v_claim constant text := 'public.claim_release_purges(integer)';
  v_read constant text := 'public.release_read_rows(uuid, jsonb)';
  v_have text[];
  v_bad text;
  p text;
begin
  -- ---- The ledger: RLS on and forced, no policy at all.
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.cache_purge_log'::regclass) then
    raise exception '0103: cache_purge_log is not ENABLE + FORCE row level security';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'cache_purge_log') then
    raise exception '0103: cache_purge_log has a policy; it must have none';
  end if;

  -- ---- Its privileges, as each API role holds them: PUBLIC, anon and authenticated nothing;
  -- the service role SELECT, INSERT and DELETE; no TRUNCATE, REFERENCES, TRIGGER or MAINTAIN
  -- for anyone; no column grant.
  select string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv) into v_bad
    from (select x.who, pr.priv,
                 has_table_privilege(x.who::name, 'public.cache_purge_log', pr.priv) as held,
                 pr.priv = any (x.allowed) as wanted
            from (values ('public', array[]::text[]),
                         ('anon', array[]::text[]),
                         ('authenticated', array[]::text[]),
                         ('service_role', array['select', 'insert', 'delete']))
                   as x(who, allowed)
            cross join unnest(v_privs) as pr(priv)) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0103: wrong table privileges on cache_purge_log (role privilege): %', v_bad;
  end if;
  if exists (select 1 from pg_attribute a
              where a.attrelid = 'public.cache_purge_log'::regclass and a.attnum > 0
                and not a.attisdropped and cardinality(coalesce(a.attacl, '{}'::aclitem[])) > 0) then
    raise exception '0103: cache_purge_log carries a column grant';
  end if;
  foreach p in array array['public', 'anon', 'authenticated'] loop
    if has_any_column_privilege(p::name, 'public.cache_purge_log', 'select, insert, update, references') then
      raise exception '0103: % holds a column privilege on cache_purge_log', p;
    end if;
  end loop;

  -- ---- The ledger's rules, by name: the key, the tenant's cascade, the two CHECKs (NOT NULL
  -- is a pg_constraint row from PostgreSQL 18 on, and is left out); no trigger.
  select coalesce(array_agg(c.conname::text order by c.conname collate "C"), '{}') into v_have
    from pg_constraint c
   where c.conrelid = 'public.cache_purge_log'::regclass and c.contype::text <> 'n';
  if v_have is distinct from array['cache_purge_log_pkey', 'cache_purge_log_source',
                                   'cache_purge_log_tag_count', 'cache_purge_log_tenant_id_fkey'] then
    raise exception '0103: cache_purge_log constraints are %', v_have;
  end if;
  if not exists (select 1 from pg_constraint c
                  where c.conname = 'cache_purge_log_tenant_id_fkey'
                    and c.conrelid = 'public.cache_purge_log'::regclass
                    and c.confrelid = 'public.tenants'::regclass
                    and c.confdeltype::text = 'c') then
    raise exception '0103: cache_purge_log.tenant_id must reference tenants ON DELETE CASCADE';
  end if;
  if exists (select 1 from pg_trigger t
              where t.tgrelid = 'public.cache_purge_log'::regclass and not t.tgisinternal) then
    raise exception '0103: cache_purge_log has a trigger; it must have none';
  end if;

  -- ---- The three functions: SECURITY INVOKER with an empty search_path; the two cron
  -- functions also bound their lock waits (lock_timeout 5s).
  foreach p in array array[v_take, v_claim, v_read] loop
    if not exists (select 1 from pg_proc f
                    where f.oid = p::regprocedure and not f.prosecdef
                      and exists (select 1 from unnest(coalesce(f.proconfig, '{}'::text[])) c
                                   where c in ('search_path=""', 'search_path='))) then
      raise exception '0103: % must be SECURITY INVOKER with an empty search_path', p;
    end if;
  end loop;
  foreach p in array array[v_take, v_claim] loop
    if not exists (select 1 from pg_proc f
                    where f.oid = p::regprocedure
                      and 'lock_timeout=5s' = any (coalesce(f.proconfig, '{}'::text[]))) then
      raise exception '0103: % must set lock_timeout 5s', p;
    end if;
  end loop;
  if (select provolatile::text from pg_proc where oid = v_read::regprocedure) <> 's' then
    raise exception '0103: % must be STABLE (it only reads)', v_read;
  end if;

  -- ---- Who may execute them: the two cron functions the service role only; the read
  -- authenticated only (it is the publisher's own read, as the caller).
  select string_agg(format('%s %s', g.who, g.fn), ', ' order by g.fn, g.who) into v_bad
    from (select x.who, f.fn,
                 has_function_privilege(x.who::name, f.fn, 'execute') as held,
                 (f.fn = v_read and x.who = 'authenticated')
                   or (f.fn <> v_read and x.who = 'service_role') as wanted
            from (values ('public'), ('anon'), ('authenticated'), ('service_role')) as x(who)
            cross join unnest(array[v_take, v_claim, v_read]) as f(fn)) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0103: wrong EXECUTE privileges (role function): %', v_bad;
  end if;

  -- ---- None of them sets a setting or names the release token (R4's catalog rule:
  -- apply_release alone sets claims; tests/lib/purgeCronSql.spec.ts pins the text).
  if exists (select 1 from pg_proc f
              where f.oid in (v_take::regprocedure, v_claim::regprocedure, v_read::regprocedure)
                and (f.prosrc ~* 'set_config' or f.prosrc ~* 'app\.release_apply'
                     or f.prosrc ~* 'set\s+(local\s+)?role')) then
    raise exception '0103: a function of this file sets a setting, a role or names the release token';
  end if;

  -- ---- Nothing was written.
  if (select count(*) from public.cache_purge_log) <> 0 then
    raise exception '0103: cache_purge_log is not empty after the migration';
  end if;
end $$;
