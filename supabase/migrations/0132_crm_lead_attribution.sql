-- ─────────────────────────────────────────────────────────────────────────────────────────
-- C13 (Admin v2, crm.md §7.3 and slice CRM-13) — lead attribution, consent-gated. Forward-only
-- and EXPAND only: seven nullable columns are added to public.leads with their CHECKs, lead
-- workers are granted SELECT on them, and public.crm_ingest_lead is restated with them on its
-- allow-list. Nothing is dropped, no existing row is written. The number is a placeholder:
-- numbers are assigned at the merge train (docs/admin-v2/migrations.md), and this file is
-- renumbered with scripts/renumber-migration.mjs to the next free number above main's highest.
-- HELD: the slice merges only after the privacy-notice text is signed off (owner item O-11).
-- Depends on 0033 (the column grants on leads), 0035 (score signals, source, channel), 0041
-- and 0091 (crm_ingest_lead as restated here), 0113 (C14b's columns) and 0129 (H16).
--
-- WHAT IS STORED, and only when the visitor said yes to analytics (the Worker checks the
-- consent through the one gate, packages/consent/gate.ts hasConsent; without it the Worker
-- sends none of these keys and a lead looks exactly as before this migration):
--   landing_path   the page the inquiry was sent from: a path, never a query or a fragment
--   referrer_host  the other site that sent the visitor: a host name, never a URL
--   utm_source / utm_medium / utm_campaign   the campaign tags: bounded lower-case slugs
--   device_class   mobile, tablet or desktop: never the User-Agent
--   country        a two-letter code from the network location: never the IP, never a city
-- and `channel` (0035), which the Worker classifies from them.
--
-- The CHECKs are the second layer behind the Worker's cleaners (src/lib/crm/attribution.ts):
-- no `@` and no run of seven digits in a path or a tag, so an e-mail address or a phone number
-- a link carried cannot be stored here. A refused value refuses the insert; the Worker then
-- sends the lead again without its attribution (src/lib/data/leads.ts), so attribution never
-- costs a lead.
--
-- Retention and erasure need nothing new: the values live on the lead row, so they go when the
-- lead goes (app.purge_leads, the spam horizon, crm_erase_lead). Staff cannot write them (no
-- UPDATE grant): they are what arrived with the inquiry.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- ═══ 1. The columns ═══════════════════════════════════════════════════════════════════════════
-- Nullable with no default: adding them rewrites nothing.
alter table public.leads
  add column if not exists landing_path text,
  add column if not exists referrer_host text,
  add column if not exists utm_source text,
  add column if not exists utm_medium text,
  add column if not exists utm_campaign text,
  add column if not exists device_class text,
  add column if not exists country text;

alter table public.leads drop constraint if exists leads_landing_path_shape;
alter table public.leads add constraint leads_landing_path_shape check (
  landing_path is null
  or (landing_path ~ '^/[^?#[:space:]]{0,199}$'
      and landing_path !~ '@'
      and landing_path !~ '[0-9]{7}'));

alter table public.leads drop constraint if exists leads_referrer_host_shape;
alter table public.leads add constraint leads_referrer_host_shape check (
  referrer_host is null
  or (char_length(referrer_host) <= 253
      and referrer_host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'));

alter table public.leads drop constraint if exists leads_utm_shape;
alter table public.leads add constraint leads_utm_shape check (
  (utm_source is null
   or (utm_source ~ '^[a-z0-9][a-z0-9._+-]{0,63}$' and utm_source !~ '[0-9]{7}'))
  and (utm_medium is null
       or (utm_medium ~ '^[a-z0-9][a-z0-9._+-]{0,63}$' and utm_medium !~ '[0-9]{7}'))
  and (utm_campaign is null
       or (utm_campaign ~ '^[a-z0-9][a-z0-9._+-]{0,63}$' and utm_campaign !~ '[0-9]{7}')));

alter table public.leads drop constraint if exists leads_device_class_check;
alter table public.leads add constraint leads_device_class_check check (
  device_class is null or device_class in ('mobile', 'tablet', 'desktop'));

alter table public.leads drop constraint if exists leads_country_shape;
alter table public.leads add constraint leads_country_shape check (
  country is null or country ~ '^[A-Z]{2}$');

-- ═══ 2. Grants, stated (P-14) ═════════════════════════════════════════════════════════════════
-- Lead workers read them (RLS, leads_live and the role helpers decide which leads, as for every
-- lead column); nobody writes them through the API. anon and PUBLIC hold nothing on leads.
grant select (landing_path, referrer_host, utm_source, utm_medium, utm_campaign, device_class,
              country)
  on public.leads to authenticated;

-- ═══ 3. Arrival, restated: the attribution keys ═══════════════════════════════════════════════
-- 0091's function, with one change: the seven attribution keys join the allow-list and the
-- insert. The Worker sends them only with the visitor's analytics consent; a lead without them
-- is inserted exactly as before. tests/lib/createLead.spec.ts reads the allow-list from the last
-- definition.
create or replace function public.crm_ingest_lead(p_tenant uuid, p_lead jsonb) returns uuid
  language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_signals text[];
  v_scoring jsonb;
  v_email_hmac text := nullif(p_lead ->> 'email_hmac', '');
  v_phone_hmac text := nullif(p_lead ->> 'phone_hmac', '');
  v_manual boolean;
  v_creator uuid;
  v_assignee uuid;
begin
  if p_tenant is null or p_lead is null or jsonb_typeof(p_lead) <> 'object' then
    raise exception using errcode = '22023', message = 'crm_ingest_lead: a tenant and a lead object are required';
  end if;
  -- An allow-list: a key outside it is a caller bug, refused rather than ignored.
  if exists (select 1 from jsonb_object_keys(p_lead) k
              where k not in ('id', 'kind', 'locale', 'name', 'company', 'email_enc', 'phone_enc',
                              'budget_enc', 'timeline_text_enc', 'message', 'service_of_interest',
                              'discipline_of_interest', 'consent_marketing', 'email_hmac',
                              'phone_hmac', 'score_signals', 'source', 'channel', 'created_by',
                              'landing_path', 'referrer_host', 'utm_source', 'utm_medium',
                              'utm_campaign', 'device_class', 'country')) then
    raise exception using errcode = '22023', message = 'crm_ingest_lead: unknown lead field';
  end if;
  v_id := nullif(p_lead ->> 'id', '')::uuid;
  if v_id is null then
    raise exception using errcode = '22023', message = 'crm_ingest_lead: the lead id is required';
  end if;
  v_manual := coalesce(p_lead ->> 'source', 'web_form') = 'manual';
  v_creator := nullif(p_lead ->> 'created_by', '')::uuid;
  if v_manual and v_creator is null then
    raise exception using errcode = '22023', message = 'crm_ingest_lead: a manual lead names who added it';
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
  -- (0091) Who it goes to, by the tenant's rule (CRM settings, C9a).
  v_assignee := app.crm_pick_assignee(p_tenant);

  insert into public.leads (
    id, tenant_id, kind, locale, name, company, email_enc, phone_enc, budget_enc,
    timeline_text_enc, message, service_of_interest, discipline_of_interest,
    consent_marketing, email_hmac, phone_hmac, score_signals, score, source, channel,
    crm_indexed_at, created_by, first_response_at, read_at, read_by, assigned_to,
    landing_path, referrer_host, utm_source, utm_medium, utm_campaign, device_class, country)
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
    v_creator,
    -- (0041) Written down by the person who answered it, so answered and read at once.
    case when v_manual then now() end,
    case when v_manual then now() end,
    case when v_manual then v_creator end,
    v_assignee,
    -- (C13) The attribution, present only with the visitor's analytics consent. An empty
    -- string is no value; the CHECKs (1.) refuse anything else out of shape.
    nullif(p_lead ->> 'landing_path', ''), nullif(p_lead ->> 'referrer_host', ''),
    nullif(p_lead ->> 'utm_source', ''), nullif(p_lead ->> 'utm_medium', ''),
    nullif(p_lead ->> 'utm_campaign', ''), nullif(p_lead ->> 'device_class', ''),
    nullif(p_lead ->> 'country', ''))
  -- The same id again is the same lead (a retry after a lost response): nothing to do.
  on conflict (id) do nothing;
  return v_id;
end $$;
revoke all on function public.crm_ingest_lead(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.crm_ingest_lead(uuid, jsonb) to service_role;

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_attr constant text[] := array['country', 'device_class', 'landing_path', 'referrer_host',
                                  'utm_campaign', 'utm_medium', 'utm_source'];
  v_got text[];
  r text;
  c text;
  v_def text;
begin
  -- The columns exist, nullable.
  select coalesce(array_agg(a.attname::text order by a.attname::text collate "C"), '{}') into v_got
    from pg_attribute a
   where a.attrelid = 'public.leads'::regclass and a.attnum > 0 and not a.attisdropped
     and not a.attnotnull and a.attname::text = any (v_attr);
  if v_got is distinct from v_attr then
    raise exception 'C13: public.leads has the nullable attribution columns %, expected %', v_got, v_attr;
  end if;
  -- The CHECKs are there.
  if (select count(*) from pg_constraint
       where conrelid = 'public.leads'::regclass and contype = 'c'
         and conname in ('leads_landing_path_shape', 'leads_referrer_host_shape', 'leads_utm_shape',
                         'leads_device_class_check', 'leads_country_shape')) <> 5 then
    raise exception 'C13: an attribution CHECK is missing';
  end if;
  -- Staff read them and write none of them; anon, PUBLIC nothing at all.
  foreach c in array v_attr loop
    if not has_column_privilege('authenticated', 'public.leads', c, 'select')
       or has_column_privilege('authenticated', 'public.leads', c, 'insert, update, references') then
      raise exception 'C13: authenticated must hold SELECT and nothing else on leads.%', c;
    end if;
    foreach r in array array['public', 'anon'] loop
      if has_column_privilege(r::name, 'public.leads', c, 'select, insert, update, references') then
        raise exception 'C13: % holds a privilege on leads.%', r, c;
      end if;
    end loop;
  end loop;
  -- The door: SECURITY INVOKER, the service role's alone, the keys on its allow-list.
  if (select p.prosecdef from pg_proc p
       where p.oid = 'public.crm_ingest_lead(uuid, jsonb)'::regprocedure) then
    raise exception 'C13: crm_ingest_lead must stay SECURITY INVOKER';
  end if;
  if not has_function_privilege('service_role', 'public.crm_ingest_lead(uuid, jsonb)', 'execute') then
    raise exception 'C13: the service role cannot run crm_ingest_lead';
  end if;
  foreach r in array array['public', 'anon', 'authenticated'] loop
    if has_function_privilege(r::name, 'public.crm_ingest_lead(uuid, jsonb)', 'execute') then
      raise exception 'C13: % can run crm_ingest_lead', r;
    end if;
  end loop;
  select p.prosrc into v_def from pg_proc p
   where p.oid = 'public.crm_ingest_lead(uuid, jsonb)'::regprocedure;
  foreach c in array v_attr loop
    if position(quote_literal(c) in v_def) = 0 then
      raise exception 'C13: crm_ingest_lead does not accept %', c;
    end if;
  end loop;
end $$;
