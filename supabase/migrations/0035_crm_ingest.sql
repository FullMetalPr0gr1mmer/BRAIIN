-- ─────────────────────────────────────────────────────────────────────────────
-- 0035 — Leads v2, part 2: how a lead arrives (Admin v2 C1b). Forward-only, expand.
-- Depends on 0033, 0034.
--
--   • crm_settings, one row per tenant: the scoring points (docs/admin-v2/crm.md §6.3),
--     the response-time target and the time zone the later screens use. Lead workers read
--     it; CRM settings (C9) will edit it. New tenants get a row with their pipeline.
--   • leads gain:
--       email_hmac / phone_hmac  blind indexes, computed in the Worker under a labelled
--                                derivation of LEAD_PII_ENC_KEY (src/lib/crm/blindIndex.ts).
--                                Never readable by staff: exact-match lookups happen on
--                                the server.
--       score / score_signals    0-100, readable; the reasons are not (two of them come
--                                from the budget and the timeline).
--       source / channel         server-set. Never chosen by the client.
--       crm_indexed_at           when the indexes and signals were computed: the daily
--                                backfill's cursor. Set at arrival only when the Worker
--                                computed them; a lead that arrives without them stays
--                                null until the cron does.
--   • email_enc becomes optional, with "at least one channel" (manual phone-only leads, C3).
--   • public.crm_ingest_lead(p_tenant, p_lead): the service-role door for a new lead. An
--     allow-listed jsonb; the Worker's own id, so a retry after an ambiguous failure is a
--     no-op instead of a second lead (Admin v2 verification); the `returning` signal and
--     the score computed here, in the same transaction as the timeline's `created` event.
--   • public.crm_index_lead(...): the daily cron's door for leads that arrived before this
--     migration, without their indexes, or through the fallback insert. It also moves a
--     legacy plaintext timeline_band into the encrypted timeline (Admin v2 plan,
--     "timeline_band is encrypted"); the Worker does the encrypting. Not an edit: the
--     lead keeps its updated_at and updated_by.
-- Both functions are SECURITY INVOKER and executable by the service role only, like
-- public.public_write_hit (0029).
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- 1. Validation helpers (used in CHECKs, so the writers need EXECUTE) ---------------
create or replace function app.crm_scoring_ok(p jsonb) returns boolean
  language sql immutable as $$
  -- CASE first: jsonb_each() raises on a non-object, and AND does not promise its order.
  select case when jsonb_typeof(p) <> 'object' then false else
         (select bool_and(
                   e.k in ('named_service', 'budget_given', 'budget_200k_plus', 'company_email',
                           'company_named', 'timeline_given', 'returning', 'service_page')
                   -- CASE, not AND: SQL does not promise to test the type before the cast.
                   and case when jsonb_typeof(e.v) = 'number'
                            then (e.v #>> '{}')::numeric between 0 and 50
                                 and (e.v #>> '{}')::numeric = trunc((e.v #>> '{}')::numeric)
                            else false
                       end)
            from jsonb_each(p) as e(k, v)) is not false
         end
$$;
revoke all on function app.crm_scoring_ok(jsonb) from public, anon, authenticated, service_role;
grant execute on function app.crm_scoring_ok(jsonb) to authenticated, service_role;

-- The score: the points of the signals present, capped at 100. One definition, shared by
-- arrival, the backfill and (C9) recomputing after the points change. The TypeScript twin
-- is src/lib/crm/score.ts scoreFor(); tests hold them equal.
create or replace function app.lead_score(p_signals text[], p_scoring jsonb) returns smallint
  language sql immutable as $$
  select least(100, coalesce(sum(coalesce((p_scoring ->> s.signal)::int, 0)), 0))::smallint
    from (select distinct unnest(coalesce(p_signals, '{}')) as signal) s
$$;
revoke all on function app.lead_score(text[], jsonb) from public, anon, authenticated, service_role;
grant execute on function app.lead_score(text[], jsonb) to service_role;

-- ---- 2. crm_settings ---------------------------------------------------------------------
create table if not exists public.crm_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  scoring jsonb not null default jsonb_build_object(
    'service_page', 10, 'named_service', 10, 'budget_given', 15, 'budget_200k_plus', 25,
    'company_email', 10, 'returning', 10, 'company_named', 5, 'timeline_given', 5)
    check (app.crm_scoring_ok(scoring)),
  sla_hours smallint not null default 24 check (sla_hours between 1 and 168),
  timezone text not null default 'Asia/Riyadh' check (timezone in (
    'Asia/Riyadh', 'Asia/Dubai', 'Asia/Kuwait', 'Asia/Qatar', 'Asia/Bahrain', 'Asia/Muscat',
    'Africa/Cairo', 'Asia/Amman', 'Europe/London', 'UTC')),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid
);
alter table public.crm_settings enable row level security;
alter table public.crm_settings force row level security;
drop trigger if exists crm_settings_updated_at on public.crm_settings;
create trigger crm_settings_updated_at before update on public.crm_settings
  for each row execute function app.tg_set_updated_at();
drop trigger if exists crm_settings_actor on public.crm_settings;
create trigger crm_settings_actor before insert or update on public.crm_settings
  for each row execute function app.tg_set_actor();
drop trigger if exists crm_settings_version on public.crm_settings;
create trigger crm_settings_version before update on public.crm_settings
  for each row execute function app.tg_bump_version();

-- Configuration, not personal data: lead workers read it. Nobody writes it through the API
-- until CRM settings (C9) adds its capability.
drop policy if exists crm_settings_read on public.crm_settings;
create policy crm_settings_read on public.crm_settings for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_works_leads(app.current_role()));

-- New tenants: the pipeline (0034) and now the settings row.
create or replace function app.tg_tenant_crm_defaults() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  perform app.seed_lead_stages(new.id);
  insert into public.crm_settings (tenant_id) values (new.id) on conflict (tenant_id) do nothing;
  return null;
end $$;
revoke all on function app.tg_tenant_crm_defaults() from public, anon, authenticated, service_role;

insert into public.crm_settings (tenant_id)
select id from public.tenants
on conflict (tenant_id) do nothing;

-- ---- 3. New lead columns ------------------------------------------------------------------
alter table public.leads
  add column if not exists email_hmac text
    check (email_hmac is null or email_hmac ~ '^[0-9a-f]{64}$'),
  add column if not exists phone_hmac text
    check (phone_hmac is null or phone_hmac ~ '^[0-9a-f]{64}$'),
  add column if not exists crm_indexed_at timestamptz,
  add column if not exists score smallint not null default 0 check (score between 0 and 100),
  add column if not exists score_signals text[] not null default '{}'
    check (score_signals <@ array['named_service', 'budget_given', 'budget_200k_plus',
                                  'company_email', 'company_named', 'timeline_given',
                                  'returning', 'service_page']::text[]),
  add column if not exists source text not null default 'web_form'
    check (source in ('web_form', 'manual', 'import', 'style_finder')),
  add column if not exists channel text not null default 'unknown'
    check (channel in ('organic', 'social', 'paid', 'referral', 'direct', 'email', 'phone',
                       'walk_in', 'whatsapp', 'event', 'unknown'));
create index if not exists leads_tenant_email_hmac_idx on public.leads (tenant_id, email_hmac)
  where email_hmac is not null;
create index if not exists leads_tenant_phone_hmac_idx on public.leads (tenant_id, phone_hmac)
  where phone_hmac is not null;
create index if not exists leads_unindexed_idx on public.leads (created_at)
  where crm_indexed_at is null;

alter table public.leads alter column email_enc drop not null;
alter table public.leads drop constraint if exists leads_has_channel;
alter table public.leads add constraint leads_has_channel
  check (email_enc is not null or phone_enc is not null);

-- ---- 4. The doors ---------------------------------------------------------------------------
create or replace function public.crm_ingest_lead(p_tenant uuid, p_lead jsonb) returns uuid
  language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_signals text[];
  v_scoring jsonb;
  v_email_hmac text := nullif(p_lead ->> 'email_hmac', '');
  v_phone_hmac text := nullif(p_lead ->> 'phone_hmac', '');
begin
  if p_tenant is null or p_lead is null or jsonb_typeof(p_lead) <> 'object' then
    raise exception using errcode = '22023', message = 'crm_ingest_lead: a tenant and a lead object are required';
  end if;
  -- An allow-list: a key outside it is a caller bug, refused rather than ignored.
  if exists (select 1 from jsonb_object_keys(p_lead) k
              where k not in ('id', 'kind', 'locale', 'name', 'company', 'email_enc', 'phone_enc',
                              'budget_enc', 'timeline_text_enc', 'message', 'service_of_interest',
                              'discipline_of_interest', 'consent_marketing', 'email_hmac',
                              'phone_hmac', 'score_signals', 'source', 'channel', 'created_by')) then
    raise exception using errcode = '22023', message = 'crm_ingest_lead: unknown lead field';
  end if;
  v_id := nullif(p_lead ->> 'id', '')::uuid;
  if v_id is null then
    raise exception using errcode = '22023', message = 'crm_ingest_lead: the lead id is required';
  end if;
  -- A retry of a lead that did arrive (its answer was lost): nothing to do. Checked first
  -- because BEFORE INSERT triggers fire even for a row ON CONFLICT then skips, and the
  -- BEFORE phase (app.tg_lead_pipeline, 0034) would spend a lead number on it.
  if exists (select 1 from public.leads where id = v_id) then
    return v_id;
  end if;

  -- The caller's signals, minus `returning`: only this side can see earlier leads.
  select coalesce(array_agg(distinct s order by s), '{}') into v_signals
    from jsonb_array_elements_text(coalesce(p_lead -> 'score_signals', '[]'::jsonb)) s
   where s <> 'returning';
  if v_email_hmac is not null and exists (
       select 1 from public.leads
        where tenant_id = p_tenant and email_hmac = v_email_hmac and id <> v_id) then
    v_signals := v_signals || 'returning'::text;
  end if;
  select scoring into v_scoring from public.crm_settings where tenant_id = p_tenant;

  insert into public.leads (
    id, tenant_id, kind, locale, name, company, email_enc, phone_enc, budget_enc,
    timeline_text_enc, message, service_of_interest, discipline_of_interest,
    consent_marketing, email_hmac, phone_hmac, score_signals, score, source, channel,
    crm_indexed_at, created_by)
  values (
    v_id, p_tenant, coalesce(p_lead ->> 'kind', 'contact'), coalesce(p_lead ->> 'locale', 'en'),
    p_lead ->> 'name', nullif(p_lead ->> 'company', ''), p_lead ->> 'email_enc',
    p_lead ->> 'phone_enc', p_lead ->> 'budget_enc', p_lead ->> 'timeline_text_enc',
    p_lead ->> 'message', p_lead ->> 'service_of_interest', p_lead ->> 'discipline_of_interest',
    coalesce((p_lead ->> 'consent_marketing')::boolean, false), v_email_hmac, v_phone_hmac,
    v_signals, app.lead_score(v_signals, coalesce(v_scoring, '{}'::jsonb)),
    coalesce(p_lead ->> 'source', 'web_form'), coalesce(p_lead ->> 'channel', 'unknown'),
    -- Indexed only if the Worker computed the indexes (it sends the signals with them);
    -- otherwise the daily cron picks the lead up.
    case when p_lead ? 'score_signals' then now() end,
    nullif(p_lead ->> 'created_by', '')::uuid)
  -- The same id again is the same lead (a retry after a lost response): nothing to do.
  on conflict (id) do nothing;
  return v_id;
end $$;
revoke all on function public.crm_ingest_lead(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.crm_ingest_lead(uuid, jsonb) to service_role;

create or replace function public.crm_index_lead(
  p_tenant uuid,
  p_id uuid,
  p_email_hmac text,
  p_phone_hmac text,
  p_signals text[],
  p_timeline_text_enc text default null
) returns boolean
  language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_signals text[];
  v_scoring jsonb;
  v_created timestamptz;
begin
  select created_at into v_created from public.leads where tenant_id = p_tenant and id = p_id;
  if v_created is null then
    return false;
  end if;
  select coalesce(array_agg(distinct s order by s), '{}') into v_signals
    from unnest(coalesce(p_signals, '{}')) s
   where s <> 'returning';
  -- `returning`: someone with this e-mail wrote to us BEFORE this lead.
  if p_email_hmac is not null and exists (
       select 1 from public.leads
        where tenant_id = p_tenant and email_hmac = p_email_hmac and id <> p_id
          and created_at < v_created) then
    v_signals := v_signals || 'returning'::text;
  end if;
  select scoring into v_scoring from public.crm_settings where tenant_id = p_tenant;

  -- Not an edit: it changes only what the CRM derives (and moves the band), so the lead
  -- keeps its updated_at and updated_by (0034, app.tg_lead_pipeline step 0).
  update public.leads
     set email_hmac = p_email_hmac,
         phone_hmac = p_phone_hmac,
         score_signals = v_signals,
         score = app.lead_score(v_signals, coalesce(v_scoring, '{}'::jsonb)),
         crm_indexed_at = now(),
         -- The legacy plaintext band leaves the table: into the encrypted timeline when
         -- the lead has none (the Worker encrypted its label), else dropped, because the
         -- visitor's own words are already there. Never dropped with nothing in its place.
         timeline_text_enc = coalesce(timeline_text_enc, p_timeline_text_enc),
         timeline_band = case
           when coalesce(timeline_text_enc, p_timeline_text_enc) is not null then null
           else timeline_band
         end
   where tenant_id = p_tenant and id = p_id;
  return found;
end $$;
revoke all on function public.crm_index_lead(uuid, uuid, text, text, text[], text)
  from public, anon, authenticated, service_role;
grant execute on function public.crm_index_lead(uuid, uuid, text, text, text[], text) to service_role;

-- ---- 5. What staff may read -------------------------------------------------------------
-- The number, the source and the channel. Not the indexes, the reasons or the cursor.
grant select (score, source, channel) on public.leads to authenticated;

create or replace view public.leads_safe with (security_invoker = true) as
select
  id, tenant_id, kind, locale, name, message, service_of_interest,
  status, consent_marketing, created_at, updated_at, company, discipline_of_interest,
  lead_number, stage_id, is_spam, spam_marked_at, first_response_at, won_at, version,
  created_by, updated_by, score, source, channel
from public.leads;
revoke all on public.leads_safe from public, anon, authenticated;
grant select on public.leads_safe to authenticated;

revoke all on public.crm_settings from public, anon, authenticated;
grant select on public.crm_settings to authenticated;
grant select, insert, update on public.crm_settings to service_role;

-- ---- Postconditions ---------------------------------------------------------------------
do $$
declare
  v_safe constant text[] := array['id', 'tenant_id', 'kind', 'locale', 'name', 'company',
    'message', 'service_of_interest', 'discipline_of_interest', 'status',
    'consent_marketing', 'created_at', 'updated_at', 'lead_number', 'stage_id', 'is_spam',
    'spam_marked_at', 'first_response_at', 'won_at', 'version', 'created_by', 'updated_by',
    'score', 'source', 'channel'];
  v_readable text[];
  p text;
begin
  select coalesce(array_agg(a.attname::text order by a.attname), '{}')
    into v_readable
    from pg_attribute a
   where a.attrelid = 'public.leads'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.leads', a.attname::text, 'select');
  if not (v_readable @> v_safe and v_readable <@ v_safe) then
    raise exception '0035: authenticated reads leads columns % (expected exactly %)', v_readable, v_safe;
  end if;

  if exists (select 1 from public.tenants t
              where not exists (select 1 from public.crm_settings c where c.tenant_id = t.id)) then
    raise exception '0035: a tenant has no crm_settings row';
  end if;
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.crm_settings'::regclass) then
    raise exception '0035: crm_settings is not ENABLE + FORCE row level security';
  end if;
  foreach p in array array['insert', 'update', 'delete', 'truncate'] loop
    if has_table_privilege('authenticated', 'public.crm_settings', p) then
      raise exception '0035: authenticated holds % on crm_settings (C9 adds writes)', p;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.crm_settings', 'select') then
    raise exception '0035: anon can read crm_settings';
  end if;

  -- The doors are the service role's alone.
  foreach p in array array['public.crm_ingest_lead(uuid, jsonb)',
                           'public.crm_index_lead(uuid, uuid, text, text, text[], text)'] loop
    if has_function_privilege('anon', p, 'execute')
       or has_function_privilege('authenticated', p, 'execute')
       or not has_function_privilege('service_role', p, 'execute') then
      raise exception '0035: % must be executable by the service role only', p;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'app.lead_score(text[], jsonb)', 'execute')
     or has_function_privilege('anon', 'app.lead_score(text[], jsonb)', 'execute') then
    raise exception '0035: app.lead_score EXECUTE is wrong';
  end if;
  if not has_function_privilege('authenticated', 'app.crm_scoring_ok(jsonb)', 'execute')
     or not has_function_privilege('service_role', 'app.crm_scoring_ok(jsonb)', 'execute') then
    raise exception '0035: the crm_settings CHECK helper is not executable by its writers';
  end if;
end $$;
