-- ─────────────────────────────────────────────────────────────────────────────
-- 0027 — An owner may let design placeholders go live in production, per table, on the
-- record. Testimonials never.
--
-- 0025 made "no placeholder is ever live in production" absolute: every role, the owner
-- included. On 2026-09-26 the owner decided the production site should show the design
-- delivery as is until real content replaces it — sample projects, stats and leadership
-- cards — while the invented testimonial quotes stay hidden (a quote attributed to a named
-- person, published without that person, is the one thing the site must never claim).
--
-- The flag stays set on every such row. Clearing is_placeholder to get past the guard
-- would make the database forget which content is not real, and the admin dashboard
-- (dashboard_attention 'placeholder_live') would stop reminding anyone to replace it.
-- So instead of weakening the guard, the guard learns one explicit exception:
--
--   app.placeholder_live_override — one row per (tenant, table) the owner has allowed.
--     • The table_name CHECK cannot name `testimonials`, so no row, written by any role,
--       can ever let a placeholder quote go live. (0021's consent CHECK is the second wall:
--       a published quote needs recorded consent.)
--     • Private schema, RLS enabled + forced, revoked from every API role: nothing reached
--       through PostgREST can read or write it. Only the owner (the runbook, via psql or
--       `supabase db query`) sets it, and SECURITY DEFINER code reads it.
--     • Every grant and revoke is written to audit_log (hash-chained by 0002/0012's
--       trigger) with the stated reason: the exception is on the record, not a silent
--       config flip.
--   Outside production the guard is inert, as before, so the table changes nothing there.
--
-- Runbook: docs/launch-runbook.md §6c (grant, publish, revoke). CLAUDE.md §8 amended.
-- Forward-only. CLAUDE.md §3 (Pillar 1), §8, §9.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists app.placeholder_live_override (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  table_name text not null
    constraint placeholder_live_override_table check (
      table_name in ('portfolio', 'team_members', 'statistics', 'clients', 'page_sections')
    ),
  reason     text not null
    constraint placeholder_live_override_reason check (char_length(btrim(reason)) between 10 and 500),
  set_by     text not null default session_user,
  set_at     timestamptz not null default now(),
  primary key (tenant_id, table_name)
);
alter table app.placeholder_live_override enable row level security;
alter table app.placeholder_live_override force row level security;
revoke all on app.placeholder_live_override from public, anon, authenticated, service_role;
comment on table app.placeholder_live_override is
  'Owner-granted, per (tenant, table) exceptions to the 0025 production placeholder guard. '
  'Never testimonials. Set only by the runbook (§6c); every change is audit-logged. 0027.';

-- ---- Audit: every grant / revoke is on the chain ---------------------------------
create or replace function app.tg_placeholder_override_audit() returns trigger
  language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  v_row app.placeholder_live_override := case when tg_op = 'DELETE' then old else new end;
begin
  insert into public.audit_log (tenant_id, actor_role, action, entity_type, entity_id, detail)
  values (
    v_row.tenant_id,
    session_user,
    case tg_op when 'DELETE' then 'placeholder_override.revoke' else 'placeholder_override.grant' end,
    'placeholder_override',
    v_row.table_name,
    jsonb_build_object('reason', v_row.reason, 'set_by', v_row.set_by, 'op', lower(tg_op))
  );
  return null;
end $$;
revoke all on function app.tg_placeholder_override_audit() from public, anon, authenticated, service_role;

drop trigger if exists placeholder_live_override_audit on app.placeholder_live_override;
create trigger placeholder_live_override_audit
  after insert or update or delete on app.placeholder_live_override
  for each row execute function app.tg_placeholder_override_audit();

-- ---- The guard (0025), with the one exception -------------------------------------
create or replace function app.tg_placeholder_guard() returns trigger
  language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  v_row jsonb := to_jsonb(new);
  v_live boolean;
begin
  if not coalesce((v_row ->> 'is_placeholder')::boolean, false) then
    return new;
  end if;
  if tg_argv[0] = 'status' then
    v_live := (v_row ->> 'status') in ('published', 'scheduled');
  else
    v_live := coalesce((v_row ->> 'visible')::boolean, false);
  end if;
  if v_live and app.is_production()
     and not exists (
       select 1 from app.placeholder_live_override o
        where o.tenant_id = (v_row ->> 'tenant_id')::uuid
          and o.table_name = tg_table_name
     ) then
    raise exception '% % is placeholder content and cannot go live in production',
                    tg_table_name, v_row ->> 'id'
      using errcode = '42501',
            hint = 'Replace the content and clear is_placeholder first (or see runbook §6c).';
  end if;
  return new;
end $$;
-- CREATE OR REPLACE keeps the ACL; re-asserted (0011 §6c default-deny).
revoke all on function app.tg_placeholder_guard() from public, anon, authenticated, service_role;

-- ---- Postconditions --------------------------------------------------------------
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_table_privilege(r, 'app.placeholder_live_override', 'select')
       or has_table_privilege(r, 'app.placeholder_live_override', 'insert')
       or has_table_privilege(r, 'app.placeholder_live_override', 'update')
       or has_table_privilege(r, 'app.placeholder_live_override', 'delete') then
      raise exception '0027: % can reach app.placeholder_live_override', r;
    end if;
    if has_function_privilege(r, 'app.tg_placeholder_override_audit()', 'execute') then
      raise exception '0027: % can execute the override audit trigger function', r;
    end if;
  end loop;
  if not exists (
    select 1 from pg_trigger
     where tgname = 'placeholder_live_override_audit'
       and tgrelid = 'app.placeholder_live_override'::regclass and not tgisinternal
  ) then
    raise exception '0027: the override audit trigger is missing';
  end if;
end $$;
