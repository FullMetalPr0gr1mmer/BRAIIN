-- pgTAP: the leads guide names the Pipeline board (0068, Admin v2 C4c). Run with
-- `supabase test db`. help_leads_v2.test.sql proves the guide 0065 rewrote (its place, its
-- seed, who reads it) against the latest set, which is this one; this file proves what 0068
-- adds: the board's line, in both languages, seeded into a tenant, with the guide's place,
-- minutes, screens and capability unchanged.

begin;
select plan(4);

insert into public.tenants (id, name) values ('68000c4c-0000-4000-8000-00000000000a', 'LeadsBoardA');

create function _guide() returns jsonb language sql security definer as $$
  select a from jsonb_array_elements(app.help_article_set()) a
   where a ->> 'slug' = 'working-with-leads'
$$;

select is(jsonb_array_length(app.help_article_set()), 15, 'the set still holds 15 guides');
select ok(position('On the Pipeline tab each stage is a column.' in (_guide() -> 'body' ->> 'en')) > 0
          and position('في تبويب Pipeline' in (_guide() -> 'body' ->> 'ar')) > 0,
  'the leads guide names the Pipeline board, in English and in Arabic');
select ok(_guide() -> 'sort_order' = '70'::jsonb
          and _guide() -> 'minutes' = '4'::jsonb
          and _guide() -> 'screens' = '["/admin/leads"]'::jsonb
          and _guide() -> 'caps' = '["leads.manage"]'::jsonb,
  'its place, minutes, screens and capability are 0065''s');
select ok(exists (select 1 from public.help_articles h
                   where h.tenant_id = '68000c4c-0000-4000-8000-00000000000a'
                     and h.slug = 'working-with-leads' and h.body = _guide() -> 'body'),
  'a tenant is seeded with the board''s line');

select * from finish();
rollback;
