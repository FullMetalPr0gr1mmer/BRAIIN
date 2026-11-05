-- pgTAP: one pending page-visibility create per target (Admin v2 R14b review; its migration adds
-- content_drafts_one_visibility_create). Run with `supabase test db`.
-- R14b stages a page's first visibility setting as a create under a Worker-allocated id, found
-- again by its target. Two first saves at the same moment could each stage one, and publishing
-- both would hit page_visibility's one-row-per-page key and abort the release. This file proves:
--   1. the index exists, unique and partial (page_visibility creates only);
--   2. a second create for the same page is refused (23505, the index named), whatever the id's
--      case, and so is a second create for the same template;
--   3. a create for another page, another template, or the same page in another tenant lives,
--      and a pending update or another type's create is not held by it.
-- The Worker's answer to the refusal (a 409 draft conflict) is held by stagedPageVisibility.spec.

begin;
select plan(9);

insert into public.tenants (id, name) values
  ('14b10000-0000-4000-8000-00000000000a', 'VisibilityCreateA'),
  ('14b10000-0000-4000-8000-0000000000ff', 'VisibilityCreateB');

create function r14b_vis_create(p_tid text, p_target jsonb, p_op text default 'create')
returns void language sql as $$
  insert into public.content_drafts (tenant_id, entity_type, entity_id, op, payload, base_version)
  values (p_tid::uuid, 'page_visibility', gen_random_uuid(), p_op,
          jsonb_build_object('target', p_target, 'mode', 'hidden'),
          case when p_op = 'create' then null else 1 end)
$$;

-- ---- 1. the index --------------------------------------------------------------------------
select ok((select i.indisunique and i.indpred is not null
             from pg_index i
             join pg_class c on c.oid = i.indexrelid
            where c.relname = 'content_drafts_one_visibility_create'
              and i.indrelid = 'public.content_drafts'::regclass),
  'content_drafts_one_visibility_create is a unique, partial index on content_drafts');

-- ---- 2. a second create for one target is refused -------------------------------------------
select lives_ok(
  $$ select r14b_vis_create('14b10000-0000-4000-8000-00000000000a',
       '{"pageId":"14b10000-0000-4000-8000-0000000000b1"}') $$,
  'a first pending create for a page is kept');
select throws_ok(
  $$ select r14b_vis_create('14b10000-0000-4000-8000-00000000000a',
       '{"pageId":"14B10000-0000-4000-8000-0000000000B1"}') $$,
  '23505', 'duplicate key value violates unique constraint "content_drafts_one_visibility_create"',
  'a second pending create for the same page is refused, whatever the case of its id');
select lives_ok(
  $$ select r14b_vis_create('14b10000-0000-4000-8000-00000000000a', '{"template":"service"}') $$,
  'a first pending create for a template is kept');
select throws_ok(
  $$ select r14b_vis_create('14b10000-0000-4000-8000-00000000000a', '{"template":"service"}') $$,
  '23505', 'duplicate key value violates unique constraint "content_drafts_one_visibility_create"',
  'a second pending create for the same template is refused');

-- ---- 3. what it does not hold ---------------------------------------------------------------
select lives_ok(
  $$ select r14b_vis_create('14b10000-0000-4000-8000-00000000000a',
       '{"pageId":"14b10000-0000-4000-8000-0000000000b2"}');
     select r14b_vis_create('14b10000-0000-4000-8000-00000000000a', '{"template":"case_study"}') $$,
  'another page and another template each keep their own create');
select lives_ok(
  $$ select r14b_vis_create('14b10000-0000-4000-8000-0000000000ff',
       '{"pageId":"14b10000-0000-4000-8000-0000000000b1"}') $$,
  'another tenant keeps its own create for the same page id');
select lives_ok(
  $$ select r14b_vis_create('14b10000-0000-4000-8000-00000000000a',
       '{"pageId":"14b10000-0000-4000-8000-0000000000b1"}', 'update') $$,
  'a pending update naming the same target is not held by it (its row has its own key)');
select lives_ok(
  $$ insert into public.content_drafts (tenant_id, entity_type, entity_id, op, payload)
     values ('14b10000-0000-4000-8000-00000000000a', 'service', gen_random_uuid(), 'create',
             '{"target":{"pageId":"14b10000-0000-4000-8000-0000000000b1"}}') $$,
  'another type''s create is not held by it');

select * from finish();
rollback;
