-- ─────────────────────────────────────────────────────────────────────────────
-- 0063 — Leads v2, part 5: the readers v2 (Admin v2 C4a). Forward-only, EXPAND only.
-- Depends on 0033 (the leads column grant, app.live_role, leads_live), 0034 (lead_stages,
-- the pipeline), 0035 (crm_settings.sla_hours, leads.source and channel), 0036 (the readers
-- this file restates) and 0041 (assigned_to, value_sar, is_starred, read_at, the logged
-- contact).
--
-- C3 (0041) gave a lead its assignee, value, star, read mark and logged contact, but the
-- 0036 readers neither return nor filter by them. The leads screens (C4b) need both. So:
--
--   • app.lead_filter v2 (dropped and recreated: its RETURNS TABLE grows, which create or
--     replace cannot do). Every 0036 key keeps its meaning; new keys: `assigned` ('me', read
--     in SQL as auth.uid() and never a client's uuid, 'none', or a person's uuid), `starred`,
--     `unread` (read_at is null), `source`, `channel` (the 0035 CHECKs' lists) and
--     `discipline` (a slug); `sort` gains 'starred' (starred first, then newest). The board
--     now refuses spam, sort, limit and offset as well as stage, so its contract is stated.
--   • app.leads_matching: the ONE place a filter becomes a set of leads in an order (the
--     lead's id and its position). leads_list pages it, lead_neighbours steps through it
--     and leads_board groups it, so Previous and Next can never drift from the list's order
--     and the three readers apply the same predicates. SECURITY INVOKER.
--   • app.lead_over_sla: the one SLA rule, for the list's flag and the summary's count: a
--     web-form lead, not spam, still in the initial stage, never answered, older than the
--     tenant's crm_settings.sla_hours (24 when the row cannot be read).
--   • public.leads_list restated (same signature, a jsonb answer): rows gain assigned_to,
--     value_sar, is_starred, read_at, last_contact_at, last_contact_channel and over_sla.
--   • public.leads_board dropped and recreated (its RETURNS TABLE grows by value_sum, the
--     stage's matching non-spam value in SAR, appended last); cards gain stage_id,
--     assigned_to, value_sar, is_starred and read_at.
--   • public.lead_summary restated: 0036's keys unchanged, plus in_progress, won_value,
--     unread, starred, per_stage (every stage, zeros included), sla_breached and the web
--     form's first response (web_response_hours, web_response_n). A date range is still its
--     only filter.
--   • public.lead_neighbours (new): the lead before (newer) and after a lead in the list's
--     order and filter, for the detail page's Previous and Next.
--
-- No table, column, policy or grant on leads changes: every reader is SECURITY INVOKER, so
-- RLS, the RESTRICTIVE live check (leads_live) and 0041's column grant decide what each
-- returns, and none of them names a gated column (no tags, score reason, blind index,
-- ciphertext or note). The postconditions prove the leads grants are 0041's exactly.
--
-- Apply-then-merge (Admin v2 rule 5): between this push and the deploy the deployed Worker
-- reads the new shapes. Its parsers name the keys they keep (query.ts and board.ts reduce
-- rows with pick(), summary.ts reads named keys, the dashboard, the stats card and the
-- manual-add lookup read named keys), and it sends no key the new filter refuses.
-- docs/admin-v2/as-built/C4a.md has the proof.
-- ─────────────────────────────────────────────────────────────────────────────

-- These functions serve every lead screen and the manual-add duplicate lookup; a statement
-- that waits more than five seconds for a lock raises instead, the whole file rolls back,
-- and the push is retried. Transaction-local: it ends with this migration.
set local lock_timeout = '5s';

-- What the postconditions compare against: the leads columns before this file.
select set_config('c4a.leads_columns',
  (select string_agg(a.attname::text, ',' order by a.attname)
     from pg_attribute a
    where a.attrelid = 'public.leads'::regclass and a.attnum > 0 and not a.attisdropped),
  true);

-- ---- 1. The filter, v2 ----------------------------------------------------------------------
-- Dropped first: the readers call it only from plpgsql bodies (no catalog dependency), and
-- this file recreates every one of them, in one transaction, so no caller sees a gap.
drop function if exists app.lead_filter(jsonb, boolean);
create function app.lead_filter(p jsonb, p_board boolean default false)
  returns table (
    stage uuid, spam boolean, needle text, contact_kind text, contact_hmac text,
    created_from timestamptz, created_to timestamptz, sort text, page_limit int,
    page_offset int, per_stage int,
    assigned_kind text, assigned_id uuid, starred boolean, unread boolean, source text,
    channel text, discipline text)
  -- STABLE, not immutable: a timestamp without an offset is read in the session's zone, and
  -- 'me' is the session's user.
  language plpgsql stable as $$
declare
  f jsonb := coalesce(p, '{}'::jsonb);
  v_q text;
  v_assigned text;
begin
  if jsonb_typeof(f) <> 'object' then
    raise exception using errcode = '22023', message = 'lead filter: an object is required';
  end if;
  if exists (select 1 from jsonb_object_keys(f) k
              where k not in ('stage', 'spam', 'q', 'contact_kind', 'contact_hmac', 'from', 'to',
                              'sort', 'limit', 'offset', 'per_stage',
                              'assigned', 'starred', 'unread', 'source', 'channel',
                              'discipline')) then
    raise exception using errcode = '22023', message = 'lead filter: unknown key';
  end if;
  begin
    stage := nullif(f ->> 'stage', '')::uuid;
    spam := coalesce((f ->> 'spam')::boolean, false);
    created_from := nullif(f ->> 'from', '')::timestamptz;
    created_to := nullif(f ->> 'to', '')::timestamptz;
    page_limit := coalesce((f ->> 'limit')::int, 25);
    page_offset := coalesce((f ->> 'offset')::int, 0);
    per_stage := coalesce((f ->> 'per_stage')::int, 20);
    starred := (f ->> 'starred')::boolean;
    unread := (f ->> 'unread')::boolean;
  exception when others then
    raise exception using errcode = '22023', message = 'lead filter: a value has the wrong type';
  end;
  sort := coalesce(f ->> 'sort', 'newest');
  if sort not in ('newest', 'oldest', 'score', 'starred') then
    raise exception using errcode = '22023', message = 'lead filter: sort is newest, oldest, score or starred';
  end if;
  if page_limit not between 1 and 100 or page_offset not between 0 and 10000
     or per_stage not between 1 and 50 then
    raise exception using errcode = '22023', message = 'lead filter: a page bound is out of range';
  end if;
  contact_kind := f ->> 'contact_kind';
  contact_hmac := f ->> 'contact_hmac';
  if (contact_kind is null) <> (contact_hmac is null)
     or (contact_kind is not null and (contact_kind not in ('email', 'phone')
                                       or contact_hmac !~ '^[0-9a-f]{64}$')) then
    raise exception using errcode = '22023', message = 'lead filter: contact_kind and contact_hmac go together';
  end if;
  v_q := f ->> 'q';
  if v_q is not null then
    if char_length(v_q) > 64 or v_q ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'lead filter: q is at most 64 printable characters';
    end if;
    -- A second layer behind the Worker (src/lib/crm/leadQuery.ts): an e-mail address or a
    -- phone number is found by its blind index only, so one sent as text is refused rather
    -- than searched. The phone test is the Worker's: phone characters only, 7+ digits.
    if strpos(v_q, '@') > 0
       or (v_q ~ '^[-+0-9[:space:]().٠-٩۰-۹]+$'
           and char_length(regexp_replace(v_q, '[^0-9٠-٩۰-۹]', '', 'g')) >= 7) then
      raise exception using errcode = '22023',
        message = 'lead filter: an e-mail address or a phone number is searched by its blind index';
    end if;
    -- Folded like search_text, then escaped: a % or _ in the query is a character.
    needle := nullif(replace(replace(replace(
                lower(coalesce(app.normalize_ar_q(btrim(v_q)), '')),
                '\', '\\'), '%', '\%'), '_', '\_'), '');
  end if;

  -- (C4a) Whose leads. 'me' is the session's user, resolved here: a client never names
  -- itself, so it cannot ask for another person's leads under the word "me". A person is a
  -- uuid, filtered as sent (the column grant and RLS still decide which leads exist).
  v_assigned := f ->> 'assigned';
  if v_assigned is not null then
    if v_assigned = 'me' then
      assigned_kind := 'me';
      assigned_id := auth.uid();
    elsif v_assigned = 'none' then
      assigned_kind := 'none';
    elsif v_assigned ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      assigned_kind := 'person';
      assigned_id := v_assigned::uuid;
    else
      raise exception using errcode = '22023', message = 'lead filter: assigned is me, none or a person';
    end if;
  end if;
  -- (C4a) The closed lists of leads.source and leads.channel (0035's CHECKs;
  -- tests/lib/crmLeadsReadersSql.spec.ts holds them equal to packages/schemas/crm.ts).
  source := f ->> 'source';
  if source is not null and source not in ('web_form', 'manual', 'import', 'style_finder') then
    raise exception using errcode = '22023', message = 'lead filter: unknown source';
  end if;
  channel := f ->> 'channel';
  if channel is not null and channel not in ('organic', 'social', 'paid', 'referral', 'direct',
                                             'email', 'phone', 'walk_in', 'whatsapp', 'event',
                                             'unknown') then
    raise exception using errcode = '22023', message = 'lead filter: unknown channel';
  end if;
  -- A slug's shape (packages/schemas SlugSchema), at most 64 characters.
  discipline := f ->> 'discipline';
  if discipline is not null
     and (char_length(discipline) > 64 or discipline !~ '^[a-z0-9]+(-[a-z0-9]+)*$') then
    raise exception using errcode = '22023', message = 'lead filter: discipline is a slug';
  end if;

  -- The board shows every stage, spam excluded, newest first, each column capped by
  -- per_stage: a stage, a spam flag, a sort or a page is the list's alone.
  if p_board and (stage is not null or f ?| array['spam', 'sort', 'limit', 'offset']) then
    raise exception using errcode = '22023',
      message = 'lead filter: the board takes no stage, spam flag, sort or page';
  end if;
  return next;
end $$;
revoke all on function app.lead_filter(jsonb, boolean) from public, anon, authenticated, service_role;
grant execute on function app.lead_filter(jsonb, boolean) to authenticated;

-- ---- 2. The SLA rule -------------------------------------------------------------------------
-- A web-form lead waiting longer than the tenant's response time: still in the initial
-- stage, never answered, not spam. One definition for the list's flag and the summary's
-- count (crm.md §9 "SLA breach"). An inlinable SQL function, so it costs a comparison.
create or replace function app.lead_over_sla(
  p_source text, p_initial boolean, p_first_response_at timestamptz,
  p_created_at timestamptz, p_spam boolean, p_sla_hours int)
  returns boolean language sql stable as $$
  select coalesce(p_source = 'web_form' and p_initial and not p_spam
                  and p_first_response_at is null
                  and p_created_at < now() - make_interval(hours => p_sla_hours), false)
$$;
revoke all on function app.lead_over_sla(text, boolean, timestamptz, timestamptz, boolean, int)
  from public, anon, authenticated, service_role;
grant execute on function app.lead_over_sla(text, boolean, timestamptz, timestamptz, boolean, int)
  to authenticated;

-- ---- 3. The matching leads, in the list's order ----------------------------------------------
-- The one predicate set and the one order (Admin v2 C4 D14): leads_list pages this,
-- lead_neighbours steps through it and leads_board groups it. INVOKER: RLS, the live check
-- and the column grants apply; it reads only granted columns, and returns ids and positions.
-- The tenant is named by the Worker as well, and nothing matches unless it is the token's.
create or replace function app.leads_matching(p_tenant uuid, p_filter jsonb,
                                              p_board boolean default false)
  returns table (lead_id uuid, pos bigint)
  language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  f record;
begin
  select * into f from app.lead_filter(p_filter, p_board);
  return query
  select l.id,
         row_number() over (
           -- 'newest' is exactly 0036's order (created_at desc, id), so the dashboard's
           -- latest leads do not move; 'starred' puts starred leads first, then newest.
           order by case when f.sort = 'starred' then l.is_starred end desc nulls last,
                    case when f.sort = 'score' then l.score end desc nulls last,
                    case when f.sort = 'oldest' then l.created_at end asc,
                    l.created_at desc, l.id)
    from public.leads l
   where l.tenant_id = app.effective_tenant_id()
     and l.tenant_id = p_tenant
     and l.is_spam = f.spam
     and (f.stage is null or l.stage_id = f.stage)
     and (f.created_from is null or l.created_at >= f.created_from)
     and (f.created_to is null or l.created_at < f.created_to)
     and (f.needle is null or l.search_text like '%' || f.needle || '%' escape '\')
     and (f.contact_hmac is null
          or l.id in (select app.leads_with_contact(f.contact_kind, f.contact_hmac)))
     -- (C4a) whose, starred, unread, where from
     and (f.assigned_kind is null
          or (f.assigned_kind = 'none' and l.assigned_to is null)
          or (f.assigned_kind in ('me', 'person') and l.assigned_to = f.assigned_id))
     and (f.starred is null or l.is_starred = f.starred)
     and (f.unread is null or (l.read_at is null) = f.unread)
     and (f.source is null or l.source = f.source)
     and (f.channel is null or l.channel = f.channel)
     -- (C4a) a discipline: the "help me choose" answer, or a service in that discipline. The
     -- services and disciplines are read as the caller (staff read every status).
     and (f.discipline is null
          or l.discipline_of_interest::text = f.discipline
          or exists (select 1
                       from public.services sv
                       join public.disciplines d
                         on d.id = sv.discipline_id and d.tenant_id = sv.tenant_id
                      where sv.tenant_id = l.tenant_id
                        and sv.slug::text = l.service_of_interest::text
                        and d.slug::text = f.discipline));
end $$;
revoke all on function app.leads_matching(uuid, jsonb, boolean) from public, anon, authenticated, service_role;
grant execute on function app.leads_matching(uuid, jsonb, boolean) to authenticated;

-- ---- 4. The readers (INVOKER: RLS, the live check and the column grants apply) ------------

-- {total, rows}: the total counts every match apart from the page, so a page past the end
-- is an empty page of a known total, never "no leads".
create or replace function public.leads_list(p_tenant uuid, p_filter jsonb default '{}'::jsonb)
  returns jsonb
  language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  f record;
  v_sla int;
begin
  select * into f from app.lead_filter(p_filter);
  -- The tenant's response time, read as the caller (lead workers read crm_settings).
  v_sla := coalesce((select cs.sla_hours from public.crm_settings cs
                      where cs.tenant_id = app.effective_tenant_id()
                        and cs.tenant_id = p_tenant), 24);
  return (
    with matching as (
      select m.lead_id, m.pos from app.leads_matching(p_tenant, p_filter) m
    ),
    page as (
      select l.id, l.lead_number, l.name, l.company, left(l.message, 140) as message_preview,
             l.service_of_interest::text as service_of_interest,
             l.discipline_of_interest::text as discipline_of_interest, l.stage_id, l.is_spam,
             l.score, l.source, l.channel, l.created_at, l.first_response_at, l.won_at, l.version,
             -- (C4a)
             l.assigned_to, l.value_sar, l.is_starred, l.read_at, l.last_contact_at,
             l.last_contact_channel,
             app.lead_over_sla(l.source, s.is_initial, l.first_response_at, l.created_at,
                               l.is_spam, v_sla) as over_sla,
             m.pos
        from matching m
        join public.leads l on l.tenant_id = app.effective_tenant_id() and l.id = m.lead_id
        left join public.lead_stages s on s.tenant_id = l.tenant_id and s.id = l.stage_id
       where m.pos > f.page_offset
         and m.pos <= f.page_offset + f.page_limit
    )
    select jsonb_build_object(
             'total', (select count(*) from matching),
             'rows', coalesce((select jsonb_agg(to_jsonb(p) - 'pos' order by p.pos) from page p),
                              '[]'::jsonb)));
end $$;

-- Every stage of the tenant with its count, its value and its newest cards, spam excluded.
-- Dropped and recreated: the RETURNS TABLE grows (value_sum, appended last, so a reader by
-- name or by position up to `leads` reads what it read before).
drop function if exists public.leads_board(uuid, jsonb);
create function public.leads_board(p_tenant uuid, p_filter jsonb default '{}'::jsonb)
  returns table (stage_id uuid, total bigint, leads jsonb, value_sum numeric)
  language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  f record;
begin
  select * into f from app.lead_filter(p_filter, true);
  return query
  with matching as (
    select m.lead_id, m.pos from app.leads_matching(p_tenant, p_filter, true) m
  ),
  cards as (
    select l.id, l.lead_number, l.name, l.company, l.service_of_interest,
           l.discipline_of_interest, l.stage_id, l.score, l.created_at, l.version,
           l.assigned_to, l.value_sar, l.is_starred, l.read_at, m.pos,
           row_number() over (partition by l.stage_id order by m.pos) as rn,
           count(*) over (partition by l.stage_id) as n
      from matching m
      join public.leads l on l.tenant_id = app.effective_tenant_id() and l.id = m.lead_id
  )
  select s.id,
         coalesce(max(c.n), 0)::bigint,
         coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'lead_number', c.lead_number, 'name', c.name, 'company', c.company,
           'service_of_interest', c.service_of_interest,
           'discipline_of_interest', c.discipline_of_interest, 'score', c.score,
           'created_at', c.created_at, 'version', c.version,
           'stage_id', c.stage_id, 'assigned_to', c.assigned_to, 'value_sar', c.value_sar,
           'is_starred', c.is_starred, 'read_at', c.read_at)
           order by c.pos) filter (where c.rn <= f.per_stage), '[]'::jsonb),
         coalesce(sum(c.value_sar), 0)::numeric
    from public.lead_stages s
    left join cards c on c.stage_id = s.id
   where s.tenant_id = app.effective_tenant_id()
     and s.tenant_id = p_tenant
   group by s.id, s.sort_order, s.key
   order by s.sort_order, s.key;
end $$;

-- The KPIs for a date range (crm.md §9): counts and sums only, never a lead. 0036's keys
-- keep their exact meaning (the dashboard and the stats card read them).
create or replace function public.lead_summary(p_tenant uuid, p_filter jsonb default '{}'::jsonb)
  returns jsonb
  language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  f record;
  v jsonb;
  v_sla int;
begin
  select * into f from app.lead_filter(p_filter);
  if f.stage is not null or f.needle is not null or f.contact_hmac is not null
     or f.assigned_kind is not null or f.starred is not null or f.unread is not null
     or f.source is not null or f.channel is not null or f.discipline is not null then
    raise exception using errcode = '22023', message = 'lead summary: a date range is its only filter';
  end if;
  v_sla := coalesce((select cs.sla_hours from public.crm_settings cs
                      where cs.tenant_id = app.effective_tenant_id()
                        and cs.tenant_id = p_tenant), 24);
  select jsonb_build_object(
           'total', count(*) filter (where not l.is_spam),
           'new', count(*) filter (where not l.is_spam and s.is_initial),
           'open', count(*) filter (where not l.is_spam and s.kind = 'open'),
           'won', count(*) filter (where not l.is_spam and s.kind = 'won'),
           'lost', count(*) filter (where not l.is_spam and s.kind = 'lost'),
           'spam', count(*) filter (where l.is_spam),
           'avg_first_response_hours', round((avg(extract(epoch from (l.first_response_at - l.created_at)))
             filter (where l.first_response_at is not null and not l.is_spam) / 3600)::numeric, 1),
           -- (C4a)
           'in_progress', count(*) filter (where not l.is_spam and s.kind = 'open' and not s.is_initial),
           'won_value', coalesce(sum(l.value_sar) filter (where not l.is_spam and s.kind = 'won'), 0),
           'unread', count(*) filter (where not l.is_spam and l.read_at is null),
           'starred', count(*) filter (where not l.is_spam and l.is_starred),
           'sla_breached', count(*) filter (
             where app.lead_over_sla(l.source, s.is_initial, l.first_response_at, l.created_at,
                                     l.is_spam, v_sla)),
           'web_response_hours', round((avg(extract(epoch from (l.first_response_at - l.created_at)))
             filter (where l.source = 'web_form' and l.first_response_at is not null
                       and not l.is_spam) / 3600)::numeric, 1),
           'web_response_n', count(*) filter (where l.source = 'web_form'
                                                and l.first_response_at is not null
                                                and not l.is_spam))
    into v
    from public.leads l
    join public.lead_stages s on s.id = l.stage_id
   where l.tenant_id = app.effective_tenant_id()
     and l.tenant_id = p_tenant
     and (f.created_from is null or l.created_at >= f.created_from)
     and (f.created_to is null or l.created_at < f.created_to);
  -- (C4a) Every stage the caller reads, with its non-spam count in the range, zeros included.
  return v || jsonb_build_object('per_stage', (
    select coalesce(jsonb_object_agg(s.id::text, coalesce(c.n, 0)), '{}'::jsonb)
      from public.lead_stages s
      left join (select l.stage_id, count(*) as n
                   from public.leads l
                  where l.tenant_id = app.effective_tenant_id()
                    and l.tenant_id = p_tenant
                    and not l.is_spam
                    and (f.created_from is null or l.created_at >= f.created_from)
                    and (f.created_to is null or l.created_at < f.created_to)
                  group by l.stage_id) c on c.stage_id = s.id
     where s.tenant_id = app.effective_tenant_id()
       and s.tenant_id = p_tenant));
end $$;

-- ---- 5. Previous and Next ---------------------------------------------------------------------
-- {prev, next}: the leads above (newer, under the default order) and below p_id in the list
-- for this filter. A lead the caller cannot see, or one the filter leaves out, has neither.
-- No search and no page: the detail page's links follow the filters a URL may carry (never
-- `q`, Admin v2 D10/D8), and a page is the list's business, not a step's.
create or replace function public.lead_neighbours(p_tenant uuid, p_id uuid,
                                                  p_filter jsonb default '{}'::jsonb)
  returns jsonb
  language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  f record;
begin
  select * into f from app.lead_filter(p_filter);
  if coalesce(p_filter, '{}'::jsonb) ?| array['q', 'contact_kind', 'contact_hmac', 'limit', 'offset'] then
    raise exception using errcode = '22023',
      message = 'lead neighbours: the URL''s filters only (no search, contact lookup or page)';
  end if;
  return (
    with matching as (
      select m.lead_id, m.pos from app.leads_matching(p_tenant, p_filter) m
    ),
    here as (select m.pos from matching m where m.lead_id = p_id)
    select jsonb_build_object(
             'prev', (select m.lead_id from matching m, here h where m.pos = h.pos - 1),
             'next', (select m.lead_id from matching m, here h where m.pos = h.pos + 1)));
end $$;

-- ---- 6. Grants (Admin v2 P-14: revoke everything, then state the one grant) -----------------
revoke all on function public.leads_list(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.leads_board(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.lead_summary(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.lead_neighbours(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.leads_list(uuid, jsonb) to authenticated;
grant execute on function public.leads_board(uuid, jsonb) to authenticated;
grant execute on function public.lead_summary(uuid, jsonb) to authenticated;
grant execute on function public.lead_neighbours(uuid, uuid, jsonb) to authenticated;

-- ---- Postconditions ---------------------------------------------------------------------
do $$
declare
  -- 0041's sets, copied: C4a widens no grant on leads.
  v_read constant text[] := array['id', 'tenant_id', 'kind', 'locale', 'name', 'company',
    'message', 'service_of_interest', 'discipline_of_interest', 'status',
    'consent_marketing', 'created_at', 'updated_at', 'lead_number', 'stage_id', 'is_spam',
    'spam_marked_at', 'first_response_at', 'won_at', 'version', 'created_by', 'updated_by',
    'score', 'source', 'channel', 'search_text', 'assigned_to', 'value_sar', 'is_starred',
    'read_at', 'read_by', 'tags', 'last_contact_at', 'last_contact_channel'];
  v_write constant text[] := array['status', 'internal_notes', 'stage_id', 'is_spam',
    'assigned_to', 'value_sar', 'is_starred', 'read_at', 'tags', 'last_contact_at',
    'last_contact_channel'];
  v_fns constant text[] := array[
    'app.lead_filter(jsonb, boolean)',
    'app.lead_over_sla(text, boolean, timestamp with time zone, timestamp with time zone, boolean, integer)',
    'app.leads_matching(uuid, jsonb, boolean)',
    'public.leads_list(uuid, jsonb)',
    'public.leads_board(uuid, jsonb)',
    'public.lead_summary(uuid, jsonb)',
    'public.lead_neighbours(uuid, uuid, jsonb)'];
  v_cols text[];
  v_fn text;
  r text;
begin
  -- Each reader exists with its signature, runs as the caller, and only staff may call it.
  foreach v_fn in array v_fns loop
    if to_regprocedure(v_fn) is null then
      raise exception '0063: % is missing', v_fn;
    end if;
    if exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef) then
      raise exception '0063: % must be SECURITY INVOKER (RLS decides what it returns)', v_fn;
    end if;
    if not has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception '0063: authenticated cannot execute %', v_fn;
    end if;
    foreach r in array array['anon', 'public', 'service_role'] loop
      if has_function_privilege(r, v_fn, 'execute') then
        raise exception '0063: % may execute %', r, v_fn;
      end if;
    end loop;
  end loop;
  -- The board's answer, by name and position: 0036's three columns first, value_sum last.
  if (select pg_get_function_result('public.leads_board(uuid, jsonb)'::regprocedure))
     <> 'TABLE(stage_id uuid, total bigint, leads jsonb, value_sum numeric)' then
    raise exception '0063: leads_board returns %',
      pg_get_function_result('public.leads_board(uuid, jsonb)'::regprocedure);
  end if;
  -- One filter: no overload of an older shape left behind.
  if (select count(*) from pg_proc
       where proname = 'lead_filter' and pronamespace = 'app'::regnamespace) <> 1
     or (select count(*) from pg_proc
          where proname = 'leads_board' and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception '0063: an old lead_filter or leads_board overload is left';
  end if;

  -- The blind-index lookup is untouched: still a definer with an empty path, staff only.
  if not exists (select 1 from pg_proc
                  where oid = 'app.leads_with_contact(text, text)'::regprocedure and prosecdef
                    and proconfig @> array['search_path=""'])
     or has_function_privilege('anon', 'app.leads_with_contact(text, text)', 'execute')
     or has_function_privilege('public', 'app.leads_with_contact(text, text)', 'execute')
     or has_function_privilege('service_role', 'app.leads_with_contact(text, text)', 'execute')
     or not has_function_privilege('authenticated', 'app.leads_with_contact(text, text)', 'execute') then
    raise exception '0063: app.leads_with_contact changed';
  end if;

  -- What must not move: no leads column, and the staff grants are 0041's exactly.
  if (select string_agg(a.attname::text, ',' order by a.attname)
        from pg_attribute a
       where a.attrelid = 'public.leads'::regclass and a.attnum > 0 and not a.attisdropped)
     is distinct from current_setting('c4a.leads_columns', true) then
    raise exception '0063: the leads columns changed';
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname), '{}')
    into v_cols
    from pg_attribute a
   where a.attrelid = 'public.leads'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.leads', a.attname::text, 'select');
  if not (v_cols @> v_read and v_cols <@ v_read) then
    raise exception '0063: authenticated reads leads columns % (expected exactly %)', v_cols, v_read;
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname), '{}')
    into v_cols
    from pg_attribute a
   where a.attrelid = 'public.leads'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.leads', a.attname::text, 'update');
  if not (v_cols @> v_write and v_cols <@ v_write) then
    raise exception '0063: authenticated may update leads columns % (expected exactly %)', v_cols, v_write;
  end if;
  if has_table_privilege('authenticated', 'public.leads',
                         'insert, update, delete, truncate, references, trigger')
     or has_any_column_privilege('authenticated', 'public.leads', 'insert, references') then
    raise exception '0063: authenticated holds a table-wide or column INSERT privilege on leads';
  end if;
  -- anon and PUBLIC hold nothing on leads or leads_safe, table-wide or on a column. (A list
  -- of privileges is true when ANY of them is held; PUBLIC is named 'public'.)
  foreach r in array array['anon', 'public'] loop
    if has_table_privilege(r, 'public.leads',
                           'select, insert, update, delete, truncate, references, trigger')
       or has_any_column_privilege(r, 'public.leads', 'select, insert, update, references')
       or has_table_privilege(r, 'public.leads_safe',
                              'select, insert, update, delete, truncate, references, trigger')
       or has_any_column_privilege(r, 'public.leads_safe', 'select, insert, update, references') then
      raise exception '0063: % holds a privilege on leads or leads_safe', r;
    end if;
  end loop;
  -- The live check every reader relies on is still there, RESTRICTIVE.
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'leads' and policyname = 'leads_live'
                    and permissive = 'RESTRICTIVE') then
    raise exception '0063: leads_live is missing or permissive';
  end if;
end $$;
