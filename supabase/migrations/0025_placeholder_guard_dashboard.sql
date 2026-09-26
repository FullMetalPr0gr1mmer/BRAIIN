-- ─────────────────────────────────────────────────────────────────────────────
-- 0025 — Placeholders never go live in production; the dashboard says what needs
-- real content. UI v2 PR4a. Forward-only. Depends on 0016, 0021–0023.
--
-- UI v2 decision 7: the design delivery's sample projects, quotes, stats and leadership
-- are seeded PUBLISHED in local/CI/staging (so every page renders as designed) and as
-- DRAFTS in production. A draft is one click from live, so "never in production" needs
-- more than a convention: this BEFORE trigger refuses any write that leaves an
-- `is_placeholder` row live —
--   status-based   portfolio, testimonials, team_members, statistics:
--                  status published or scheduled (scheduled too, or the cron publishes it)
--   visible-based  clients, page_sections: visible
-- — but only where `app.is_production()` (the 0016 marker). No role is exempt, service
-- role and psql included: this is a statement about the data, not a permission. Making a
-- placeholder live means replacing its content and clearing `is_placeholder` — the
-- deliberate act of saying "this is real now".
--
-- dashboard_attention v2 keeps its six columns and adds:
--   placeholder_live     placeholder rows that are live (staging shows the whole seed)
--   placeholder_pending  placeholder drafts awaiting real content (production)
--   missing_alt          a published project image with no English or Arabic alt text
--   consent_missing      a quote placed on a page but with no recorded consent
-- ─────────────────────────────────────────────────────────────────────────────

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
  if v_live and app.is_production() then
    raise exception '% % is placeholder content and cannot go live in production',
                    tg_table_name, v_row ->> 'id'
      using errcode = '42501',
            hint = 'Replace the content and clear is_placeholder first.';
  end if;
  return new;
end $$;
-- A trigger function: fired by the table, never called. Default-deny (0011 §6c).
revoke all on function app.tg_placeholder_guard() from public, anon, authenticated, service_role;

do $$
declare
  t text;
  mode text;
  cols text;
begin
  for t, mode in values
    ('portfolio', 'status'), ('testimonials', 'status'), ('team_members', 'status'),
    ('statistics', 'status'), ('clients', 'visible'), ('page_sections', 'visible')
  loop
    cols := case mode when 'status' then 'status, is_placeholder' else 'visible, is_placeholder' end;
    execute format('drop trigger if exists %I on public.%I', t || '_placeholder_guard', t);
    execute format(
      'create trigger %I before insert or update of %s on public.%I
         for each row execute function app.tg_placeholder_guard(%L)',
      t || '_placeholder_guard', cols, t, mode);
  end loop;
end $$;

-- ---- dashboard_attention v2 -----------------------------------------------------------
create or replace view public.dashboard_attention with (security_invoker = true) as
  select 'scheduled_today'::text as kind, 'service'::text as entity_type, s.id, s.slug::text,
         s.title, s.scheduled_for as at
    from public.services s
   where s.status = 'scheduled' and s.scheduled_for::date = current_date
  union all
  select 'scheduled_today', 'blog_post', b.id, b.slug::text, b.title, b.scheduled_for
    from public.blog_posts b
   where b.status = 'scheduled' and b.scheduled_for::date = current_date
  union all
  select 'stale', 'blog_post', b.id, b.slug::text, b.title, b.updated_at
    from public.blog_posts b
   where b.status = 'published' and b.updated_at < now() - interval '180 days'
  union all
  select 'missing_image', 'blog_post', b.id, b.slug::text, b.title, b.updated_at
    from public.blog_posts b
   where b.status = 'published' and (b.cover_image_url is null or b.cover_image_url = '')
  -- ---- v2 ----
  union all
  select case when p.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'portfolio', p.id, p.slug::text, p.title, p.updated_at
    from public.portfolio p
   where p.is_placeholder and p.status <> 'archived'
  union all
  select case when t.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'testimonial', t.id, t.slug::text, t.author_name, t.updated_at
    from public.testimonials t
   where t.is_placeholder and t.status <> 'archived'
  union all
  select case when m.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'team_member', m.id, m.slug::text, m.name, m.updated_at
    from public.team_members m
   where m.is_placeholder and m.status <> 'archived'
  union all
  select case when st.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'statistic', st.id, st.slug::text, st.label, st.updated_at
    from public.statistics st
   where st.is_placeholder and st.status <> 'archived'
  union all
  select case when c.visible then 'placeholder_live' else 'placeholder_pending' end,
         'client', c.id, c.slug::text, c.name, c.updated_at
    from public.clients c
   where c.is_placeholder
  union all
  select case when ps.visible and pg.status = 'published' then 'placeholder_live'
              else 'placeholder_pending' end,
         'page_section', ps.id, pg.slug::text,
         jsonb_build_object('en', ps.type, 'ar', ps.type), ps.updated_at
    from public.page_sections ps
    join public.pages pg on pg.id = ps.page_id
   where ps.is_placeholder
  union all
  select 'missing_alt', 'portfolio', p.id, p.slug::text, p.title, p.updated_at
    from public.portfolio p
   where p.status = 'published'
     and exists (
       select 1 from public.media_assets ma
        where ma.kind = 'image'
          and (ma.id = p.poster_media_id
               or ma.id in (select pm.media_id from public.portfolio_media pm
                             where pm.portfolio_id = p.id))
          and (coalesce(ma.alt ->> 'en', '') = '' or coalesce(ma.alt ->> 'ar', '') = ''))
  union all
  select 'consent_missing', 'testimonial', t.id, t.slug::text, t.author_name, t.updated_at
    from public.testimonials t
   where cardinality(t.placements) > 0 and t.consent_obtained_at is null
     and t.status <> 'archived';

revoke all on public.dashboard_attention from anon;
grant select on public.dashboard_attention to authenticated;

-- ---- Postconditions -------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['portfolio', 'testimonials', 'team_members', 'statistics',
                           'clients', 'page_sections'] loop
    if not exists (select 1 from pg_trigger
                    where tgrelid = format('public.%I', t)::regclass
                      and tgname = t || '_placeholder_guard' and not tgisinternal) then
      raise exception '0025: % has no placeholder guard', t;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'app.tg_placeholder_guard()', 'execute')
     or has_function_privilege('anon', 'app.tg_placeholder_guard()', 'execute') then
    raise exception '0025: the placeholder guard is callable by an API role';
  end if;
  if not (select coalesce((select option_value = 'true' from pg_options_to_table(c.reloptions)
                            where option_name = 'security_invoker'), false)
            from pg_class c where c.oid = 'public.dashboard_attention'::regclass) then
    raise exception '0025: dashboard_attention must stay security_invoker';
  end if;
end $$;
