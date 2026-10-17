-- ─────────────────────────────────────────────────────────────────────────────
-- 0060 — The dashboard's shared layer (Admin v2 U1, AV-09+). Forward-only, expand only.
-- Depends on 0001 (tenants, profiles, app.current_role, app.is_staff), 0002 (audit_log),
-- 0031 (the audit chain's trigger), 0033 (app.live_role), 0044 (admin_user_prefs, whose
-- dashboard and quick_actions columns the per-person layout fills), 0046 (the help centre),
-- 0050 (app.role_manages_users, H10: users.manage), 0052 (app.role_analytics_read, U2:
-- analytics.read) and 0057 (U14a: the guides as it left them, U12a's 0055, U12b's 0056 and
-- U13's 0054 included).
--
-- /admin becomes a server-rendered board of widgets, each loaded only for a role whose
-- capabilities show it. A person's own layout and quick actions live in admin_user_prefs
-- (0044, self only). What the database adds for the rest:
--
--   • public.admin_role_defaults: the owner's presets, one row per tenant and role, a
--     layout ({top, left, right, hidden, quickSet}) and a list of quick actions. A person
--     with no layout of their own sees their role's preset, else the code's default. An
--     Admin writes them (users.manage, app.role_manages_users on the LIVE role); every staff
--     member reads their own role's row, an Admin every row. A RESTRICTIVE live check, as
--     F8's preferences have, so a demoted, deactivated or locked token reads and writes
--     nothing. A preset carries library actions only, never a link: an Admin could otherwise
--     plant an https link on every colleague's dashboard (README U1 D3), so the CHECK
--     (app.quick_library_only) refuses any element but {"id": "<library id>"}.
--   • public.team_notes: one shared note per tenant (at most 2,000 characters), read by every
--     holder of analytics.read (the dashboard's own capability) with a live check, written
--     by no staff token directly: public.save_team_notes() is the one door, a definer that
--     checks the live role itself, applies the rules again, takes the version (40001 on a
--     stale one) and writes the audit row in the same transaction, with the length only,
--     never the text (F8's update_my_profile pattern).
--   • No client contact details in a team note (D5, PDPL): app.team_note_problem() refuses
--     control and format characters (but tab and line feed), anything shaped like an e-mail
--     address, and a run of 8 or more digits (Western, Arabic-Indic or Extended Arabic-Indic)
--     with up to two spaces, dots, hyphens or brackets between them, the shape of a phone
--     number.
--     packages/schemas/dashboard.ts states the same rules for the Worker, and
--     tests/lib/teamNotes.spec.ts holds the two to one table of inputs, which
--     supabase/tests/dashboard_layer.test.sql runs here.
--   • app.expire_team_notes(): a note left 180 days without an edit is blanked (version + 1,
--     audited with no actor), daily by pg_cron (team-notes-retention, 03:25 UTC). Not the
--     Worker's daily cron: that one is near the Free plan's 50 subrequests.
--   • app.help_article_set() restated from 0057's text (U14a, the set on main before this one)
--     and seeded into every tenant: one new guide, your-dashboard, and finding-your-way no
--     longer names /admin (the dashboard has its own guide now). Every other guide is 0057's,
--     byte for byte.
--
-- No new capability (§5 unchanged): presets are users.manage's, team notes analytics.read's,
-- through the helpers 0050 and 0052 define.
--
-- Production as of 2026-10-16: PostgreSQL 17.6; the ledger holds 0001-0038, 0041, 0044-0046,
-- 0048, 0050, 0051, 0052, 0054, 0055, 0056 and 0057. Grants are stated for both Supabase
-- privilege regimes (README P-14). CLAUDE.md §3 (Pillar 1), §5, §7, §8, §10.
-- ─────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing (as in 0038 to 0055). The new tables'
-- foreign keys take SHARE ROW EXCLUSIVE on public.tenants, and the reseed writes
-- public.help_articles. A statement below that waits more than five seconds for a lock
-- raises instead, the whole migration rolls back, and the push is retried later.
-- Transaction-local: it ends with this migration.
set local lock_timeout = '5s';

-- ---- 1. The quick-action rule for presets ------------------------------------------------
-- Library actions only: every element an object with exactly the key `id`, a library id
-- (src/lib/admin/quickActions.ts), each once, at most 12. Invoker: the CHECK below runs as
-- the writer (an Admin's token through PostgREST, the service role), so both may call it.
create or replace function app.quick_library_only(p jsonb) returns boolean
  language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_typeof(p) = 'array'
     and pg_catalog.jsonb_array_length(p) <= 12
     and not exists (
       select 1
         from pg_catalog.jsonb_array_elements(p) as e(v)
        where pg_catalog.jsonb_typeof(e.v) <> 'object'
           or (select pg_catalog.array_agg(k order by k)
                 from pg_catalog.jsonb_object_keys(e.v) as k) is distinct from array['id']
           or pg_catalog.jsonb_typeof(e.v -> 'id') <> 'string'
           or (e.v ->> 'id') !~ '^[a-z][a-z0-9-]{1,40}$')
     and (select pg_catalog.count(distinct e.v ->> 'id') = pg_catalog.count(*)
            from pg_catalog.jsonb_array_elements(p) as e(v))
$$;
revoke all on function app.quick_library_only(jsonb) from public, anon, authenticated, service_role;
grant execute on function app.quick_library_only(jsonb) to authenticated, service_role;

-- ---- 2. The team-note rule ----------------------------------------------------------------
-- Why a text is refused, or NULL when it is fine:
--   team_notes_chars    a C0 or C1 control character other than tab and line feed, or a
--                       Unicode format character (Cf: bidi overrides and isolates,
--                       zero-width characters; 0044's list, as Unicode 15 to 17 have it);
--   team_notes_contact  something shaped like an e-mail address (non-space@non-space.non-space),
--                       or 8 or more digits of any of the three digit sets, each followed by
--                       at most two of space, dot, hyphen and brackets: a phone number as it
--                       is usually written (055.123.4567, (055) 123-4567). Slashes are not
--                       separators, so a date written 14/10/2026 passes.
-- The length (2,000 characters) is the table's CHECK and the definer's first test (after a
-- raw cap of 4,000 before its trim). The whitespace classes are written out (space, tab, line feed, vertical tab, form feed,
-- carriage return) so the database and JavaScript read them alike.
create or replace function app.team_note_problem(p text) returns text
  language sql immutable set search_path = '' as $$
  select case
    when p is null then 'team_notes_chars'
    when p ~ '[\u0001-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0001\U000E0020-\U000E007F]'
      then 'team_notes_chars'
    when p ~ '[^ \t\n\v\f\r@]+@[^ \t\n\v\f\r@]+\.[^ \t\n\v\f\r@]+'
      then 'team_notes_contact'
    when p ~ '([0-9\u0660-\u0669\u06F0-\u06F9][ .()-]{0,2}){8,}'
      then 'team_notes_contact'
  end
$$;
revoke all on function app.team_note_problem(text) from public, anon, authenticated, service_role;
-- The table's CHECK runs as the writer: the definers below (their owner) and the service
-- role, which holds the table's writes. No staff token writes the table, so none needs it.
grant execute on function app.team_note_problem(text) to service_role;

create or replace function app.team_note_ok(p text) returns boolean
  language sql immutable set search_path = '' as $$
  select app.team_note_problem(p) is null
$$;
revoke all on function app.team_note_ok(text) from public, anon, authenticated, service_role;
grant execute on function app.team_note_ok(text) to service_role;

-- ---- 3. The owner's presets -----------------------------------------------------------------
create table if not exists public.admin_role_defaults (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  role public.app_role not null,
  -- {top, left, right, hidden, quickSet}: widget ids per column (src/lib/admin/dashboard).
  -- The Worker drops unknown and forbidden ids on read and refuses them on write; a preset
  -- never grants access to anything.
  dashboard jsonb not null default '{}'::jsonb,
  -- Library actions only: [{"id": "..."}] (D3).
  quick_actions jsonb not null default '[]'::jsonb,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  primary key (tenant_id, role),
  constraint admin_role_defaults_dashboard_shape check (
    jsonb_typeof(dashboard) = 'object' and octet_length(dashboard::text) <= 16384),
  constraint admin_role_defaults_quick_actions_shape check (
    jsonb_typeof(quick_actions) = 'array' and octet_length(quick_actions::text) <= 8192
    and app.quick_library_only(quick_actions))
);

alter table public.admin_role_defaults enable row level security;
alter table public.admin_role_defaults force row level security;

-- The version and the stamps belong to the database, and a preset belongs to its tenant
-- and role for good. The version moves only when the layout or the quick actions change,
-- so a save that changes nothing is no conflict for the next one. INVOKER (a trigger needs
-- no privilege of its own); search_path '' with qualified names.
create or replace function app.tg_admin_role_defaults() returns trigger
  language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_at := pg_catalog.now();
    new.updated_at := pg_catalog.now();
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
    return new;
  end if;
  if new.tenant_id is distinct from old.tenant_id or new.role is distinct from old.role then
    raise exception using errcode = '23514',
      message = 'admin_role_defaults: a preset belongs to one tenant and one role for good';
  end if;
  new.created_at := old.created_at;
  new.created_by := old.created_by;
  if row(new.dashboard, new.quick_actions) is distinct from row(old.dashboard, old.quick_actions) then
    new.version := old.version + 1;
    new.updated_at := pg_catalog.now();
    new.updated_by := auth.uid();
  else
    new.version := old.version;
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
  end if;
  return new;
end $$;
revoke all on function app.tg_admin_role_defaults() from public, anon, authenticated, service_role;

drop trigger if exists admin_role_defaults_guard on public.admin_role_defaults;
create trigger admin_role_defaults_guard before insert or update on public.admin_role_defaults
  for each row execute function app.tg_admin_role_defaults();

-- Staff read their own role's preset; an Admin reads every role's (the JWT layer, as the
-- other staff tables read the role).
drop policy if exists admin_role_defaults_read on public.admin_role_defaults;
create policy admin_role_defaults_read on public.admin_role_defaults for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.is_staff()
         and ((role)::text = app.current_role() or app.role_manages_users(app.current_role())));

-- Only an Admin, by the LIVE role, writes one.
drop policy if exists admin_role_defaults_insert on public.admin_role_defaults;
create policy admin_role_defaults_insert on public.admin_role_defaults for insert to authenticated
  with check (tenant_id = app.effective_tenant_id()
              and app.role_manages_users((select app.live_role())));

drop policy if exists admin_role_defaults_update on public.admin_role_defaults;
create policy admin_role_defaults_update on public.admin_role_defaults for update to authenticated
  using (tenant_id = app.effective_tenant_id()
         and app.role_manages_users((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id()
              and app.role_manages_users((select app.live_role())));

drop policy if exists admin_role_defaults_delete on public.admin_role_defaults;
create policy admin_role_defaults_delete on public.admin_role_defaults for delete to authenticated
  using (tenant_id = app.effective_tenant_id()
         and app.role_manages_users((select app.live_role())));

-- RESTRICTIVE: whatever opened the door, the profile read live must hold it open, so a
-- demoted, deactivated or locked token (or one disagreeing with its profile) reads and
-- writes nothing, as F8's preferences. Its own tenant predicate (P-14).
drop policy if exists admin_role_defaults_live on public.admin_role_defaults;
create policy admin_role_defaults_live on public.admin_role_defaults as restrictive for all to authenticated
  using (tenant_id = app.effective_tenant_id() and (select app.live_role()) is not null)
  with check (tenant_id = app.effective_tenant_id() and (select app.live_role()) is not null);

-- Stated, never inherited (P-14). Staff: SELECT and DELETE on the table, INSERT on the key
-- and the two preset columns, UPDATE on the two preset columns only (never the key: the
-- trigger refuses a move anyway). The service role: the four writes it may need for an
-- operator's repair. No sequence (the key is the tenant and the role).
revoke all on table public.admin_role_defaults from public, anon, authenticated, service_role;
grant select, delete on table public.admin_role_defaults to authenticated;
grant insert (tenant_id, role, dashboard, quick_actions) on table public.admin_role_defaults to authenticated;
grant update (dashboard, quick_actions) on table public.admin_role_defaults to authenticated;
grant select, insert, update, delete on table public.admin_role_defaults to service_role;

-- ---- 4. Team notes ----------------------------------------------------------------------------
-- One per tenant, keyed by it (as site_settings and crm_settings are): no id, and no
-- created_at or created_by, because the row is the tenant's, edited in place. version 0
-- means "never saved": no row yet.
create table if not exists public.team_notes (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  body text not null default '',
  version int not null default 0,
  updated_at timestamptz,
  updated_by uuid,
  constraint team_notes_body_rule check (char_length(body) <= 2000 and app.team_note_ok(body))
);

alter table public.team_notes enable row level security;
alter table public.team_notes force row level security;

-- Every holder of analytics.read reads the note, by the LIVE role, so a stale token reads
-- nothing. No write policy: no staff token writes the table.
drop policy if exists team_notes_read on public.team_notes;
create policy team_notes_read on public.team_notes for select to authenticated
  using (tenant_id = app.effective_tenant_id()
         and app.role_analytics_read((select app.live_role())));

revoke all on table public.team_notes from public, anon, authenticated, service_role;
grant select on table public.team_notes to authenticated;
grant select, insert, update, delete on table public.team_notes to service_role;

-- The one door for a staff member: saves the caller's tenant's note under the version they
-- read (0 = no row yet), after its own live check, and writes the audit row (the length,
-- never the text) in the same transaction, so a direct PostgREST call is held to the same
-- rules and audited just the same. Trailing whitespace is trimmed first (the Worker trims
-- the same set). Refusals, for the Worker to map: 42501 not allowed; 22023 with the message
-- team_notes_length, team_notes_chars or team_notes_contact (the rule above), or
-- team_notes_version for a version that is not a count; 40001 a stale version (someone
-- saved first; the save_portfolio convention).
create or replace function public.save_team_notes(p_tenant uuid, p_body text, p_version int)
  returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role text := (select app.live_role());
  v_uid uuid := auth.uid();
  v_body text;
  v_problem text;
  v_version int;
  v_at timestamptz;
begin
  if not app.role_analytics_read(v_role) or p_tenant is distinct from app.effective_tenant_id() then
    raise exception using errcode = '42501', message = 'save_team_notes: not allowed';
  end if;
  if p_version is null or p_version < 0 then
    raise exception using errcode = '22023', message = 'team_notes_version';
  end if;
  -- The raw length first (twice the limit, the Worker's TEAM_NOTES_RAW_MAX), so a body of
  -- any size costs one length test before anything scans it; then a linear trim of the six
  -- whitespace characters (rtrim, not a `[...]+$` regex, which retries along a long run).
  if pg_catalog.char_length(coalesce(p_body, '')) > 4000 then
    raise exception using errcode = '22023', message = 'team_notes_length';
  end if;
  v_body := pg_catalog.rtrim(coalesce(p_body, ''), E' \t\n\x0B\f\r');
  if pg_catalog.char_length(v_body) > 2000 then
    raise exception using errcode = '22023', message = 'team_notes_length';
  end if;
  v_problem := app.team_note_problem(v_body);
  if v_problem is not null then
    raise exception using errcode = '22023', message = v_problem;
  end if;

  select n.version into v_version from public.team_notes n where n.tenant_id = p_tenant for update;
  if not found then
    if p_version <> 0 then
      raise exception using errcode = '40001', message = 'team_notes: someone else saved first';
    end if;
    insert into public.team_notes (tenant_id, body, version, updated_at, updated_by)
    values (p_tenant, v_body, 1, pg_catalog.now(), v_uid)
    on conflict (tenant_id) do nothing
    returning version, updated_at into v_version, v_at;
    if not found then
      -- Another first save landed between the read and this insert.
      raise exception using errcode = '40001', message = 'team_notes: someone else saved first';
    end if;
  else
    if v_version <> p_version then
      raise exception using errcode = '40001', message = 'team_notes: someone else saved first';
    end if;
    update public.team_notes n
       set body = v_body, version = n.version + 1, updated_at = pg_catalog.now(), updated_by = v_uid
     where n.tenant_id = p_tenant
    returning n.version, n.updated_at into v_version, v_at;
  end if;

  insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)
  values (p_tenant, v_uid, v_role, 'dashboard.notes.update', 'team_notes', p_tenant::text,
          pg_catalog.jsonb_build_object('length', pg_catalog.char_length(v_body)));

  return pg_catalog.jsonb_build_object('version', v_version, 'updated_at', v_at);
end $$;
revoke all on function public.save_team_notes(uuid, text, int) from public, anon, authenticated, service_role;
grant execute on function public.save_team_notes(uuid, text, int) to authenticated;

-- The retention rule (D6): a note left 180 days without an edit is blanked, its version
-- moved (an editor open on the old text gets a 409, not a silent overwrite), and the
-- clearing audited with no actor and the rule's days. Returns how many were cleared. A
-- definer for pg_cron (it runs as the job's owner); no API role executes it.
create or replace function app.expire_team_notes() returns int
  language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n int := 0;
  r record;
begin
  for r in
    update public.team_notes n
       set body = '', version = n.version + 1, updated_at = pg_catalog.now(), updated_by = null
     where n.body <> '' and n.updated_at < pg_catalog.now() - interval '180 days'
    returning n.tenant_id
  loop
    insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)
    values (r.tenant_id, null, null, 'dashboard.notes.expire', 'team_notes', r.tenant_id::text,
            pg_catalog.jsonb_build_object('days', 180));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function app.expire_team_notes() from public, anon, authenticated, service_role;

-- Daily at 03:25 UTC (06:25 in Riyadh), the 0010 pattern: where pg_cron is missing (a local
-- stack without it) the job is a notice, and the rule waits for it.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobname) from cron.job where jobname = 'team-notes-retention';
    perform cron.schedule('team-notes-retention', '25 3 * * *', $job$ select app.expire_team_notes() $job$);
  else
    raise notice 'pg_cron not installed: run app.expire_team_notes() daily by hand';
  end if;
end $$;

-- ---- 5. The guides --------------------------------------------------------------------------
-- The set as 0057 (U14a) left it, with the your-dashboard guide added and /admin taken off
-- finding-your-way's screens; every other guide is 0057's, byte for byte. A later slice that
-- changes a guide restates the set from this text (U16's rule).
create or replace function app.help_article_set() returns jsonb
  language sql immutable set search_path = '' as $fn$
  select $help$
[
  {
    "slug": "finding-your-way",
    "sort_order": 10,
    "minutes": 2,
    "tags": [
      "basics"
    ],
    "screens": [
      "/admin/search",
      "/admin/help"
    ],
    "caps": [],
    "title": "Finding your way around",
    "title_ar": "التنقل في لوحة الإدارة",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "The menu on the left shows only the screens your role can use. If you expect a screen and cannot find it, your role does not include it: ask an Admin."
        },
        {
          "t": "h",
          "x": "Getting around faster"
        },
        {
          "t": "ol",
          "x": [
            "Search: press Ctrl K, or ⌘K on a Mac, or click Search anything at the top. Type a few letters to jump to a screen or to find a page, service, project or post.",
            "The bell lists what arrived or changed for you lately.",
            "Your name at the bottom of the menu opens your account.",
            "View site opens the public site in a new tab, so you can check your work.",
            "The Help centre button at the top, an i in a circle, opens these guides, starting with the ones for the screen you are on."
          ]
        },
        {
          "t": "tip",
          "x": "Search never lists leads or job applications. They hold personal details, so they have their own screens, and every look at contact details is logged."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تعرض القائمة على اليسار الشاشات التي يتيحها دورك فقط. إذا توقعت شاشة ولم تجدها فهي ليست ضمن صلاحيات دورك، فاطلبها من أحد المسؤولين (Admin)."
        },
        {
          "t": "h",
          "x": "للتنقل بسرعة أكبر"
        },
        {
          "t": "ol",
          "x": [
            "البحث: اضغط Ctrl K، أو ⌘K على أجهزة ماك، أو انقر على Search anything في الأعلى. اكتب بضعة أحرف للانتقال إلى شاشة أو للعثور على صفحة أو خدمة أو مشروع أو مقال.",
            "يعرض الجرس ما وصلك أو تغيّر لك مؤخرًا.",
            "يفتح اسمك أسفل القائمة صفحة حسابك.",
            "يفتح View site الموقع العام في تبويب جديد لتتحقق من عملك.",
            "يفتح زر Help centre في الأعلى، وهو حرف i داخل دائرة، هذه الأدلة، بدءًا بأدلة الشاشة التي أنت عليها."
          ]
        },
        {
          "t": "tip",
          "x": "لا يعرض البحث العملاء المحتملين ولا طلبات التوظيف أبدًا، لأنها تحتوي على بيانات شخصية، فلها شاشاتها الخاصة، وكل اطلاع على بيانات التواصل يُسجَّل."
        }
      ]
    }
  },
  {
    "slug": "your-dashboard",
    "sort_order": 15,
    "minutes": 3,
    "tags": [
      "basics"
    ],
    "screens": [
      "/admin"
    ],
    "caps": [],
    "title": "Your dashboard",
    "title_ar": "لوحة التحكم الخاصة بك",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "The dashboard is the first screen after you sign in. Its widgets follow your role: each shows only what your role may see, so leads and job applications appear on it only for the roles that handle them."
        },
        {
          "t": "h",
          "x": "Arranging it your way"
        },
        {
          "t": "ol",
          "x": [
            "Press Customize at the top. Drag a widget by its handle, or use its Move buttons, to change its place or move it to another column.",
            "Hide takes a widget off your dashboard. Add widget brings a hidden one back, on the left or on the right.",
            "Reset puts your dashboard back to your role’s layout, after asking. Done ends customizing. Every change is saved as you make it.",
            "Your layout is yours alone. An Admin can save a layout and a set of quick actions as the default for a role; people in that role who have not arranged their own dashboard see it."
          ]
        },
        {
          "t": "h",
          "x": "Quick actions"
        },
        {
          "t": "p",
          "x": "Quick actions are shortcuts to the screens you use most. Customize on the Quick actions widget lets you pick them from the list your role may use, put them in order, and add up to 8 links of your own: an admin screen, starting with /admin, or an outside address starting with https://. You can have 12 in all."
        },
        {
          "t": "h",
          "x": "Team notes"
        },
        {
          "t": "p",
          "x": "Team notes is one note shared by everyone who sees the dashboard. Edit notes opens it, and Save team notes keeps your change; if someone saved first, reload their version and make your change again. A note is cleared 180 days after its last edit. It refuses anything that looks like an e-mail address or a phone number: any run of 8 or more digits, even with spaces, dots, hyphens or brackets between them. Keep client details in leads, where they are protected."
        },
        {
          "t": "tip",
          "x": "Everyone who sees the dashboard reads the team notes, so write nothing there you would not say to the whole team."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "لوحة التحكم هي أول شاشة تراها بعد تسجيل الدخول، وتتبع عناصرها دورك: يعرض كل عنصر ما يتيحه دورك فقط، فلا يظهر فيها العملاء المحتملون وطلبات التوظيف إلا للأدوار التي تتولاها."
        },
        {
          "t": "h",
          "x": "رتّبها على طريقتك"
        },
        {
          "t": "ol",
          "x": [
            "اضغط Customize في الأعلى، ثم اسحب العنصر من مقبضه، أو استخدم أزرار النقل، لتغيير مكانه أو نقله إلى عمود آخر.",
            "يزيل Hide العنصر من لوحة التحكم، ويعيد Add widget عنصرًا مخفيًا إلى اليسار أو اليمين.",
            "يعيد Reset لوحة التحكم إلى تخطيط دورك بعد أن يطلب تأكيدك، وينهي Done التخصيص. ويُحفظ كل تغيير فور إجرائه.",
            "تخطيطك خاص بك وحدك. ويستطيع المسؤول (Admin) حفظ تخطيط ومجموعة من الإجراءات السريعة كإعداد افتراضي لدور ما، فيراه أصحاب ذلك الدور ممن لم يرتّبوا لوحتهم بأنفسهم."
          ]
        },
        {
          "t": "h",
          "x": "الإجراءات السريعة"
        },
        {
          "t": "p",
          "x": "الإجراءات السريعة اختصارات إلى الشاشات التي تستخدمها أكثر من غيرها. ويتيح لك Customize في عنصر Quick actions اختيارها من القائمة التي يسمح بها دورك، وترتيبها، وإضافة حتى 8 روابط خاصة بك: شاشة إدارة تبدأ بـ /admin، أو عنوان خارجي يبدأ بـ https://. ويمكنك الاحتفاظ بـ 12 إجراءً في المجموع."
        },
        {
          "t": "h",
          "x": "ملاحظات الفريق"
        },
        {
          "t": "p",
          "x": "ملاحظات الفريق ملاحظة واحدة يشترك فيها كل من يرى لوحة التحكم. يفتحها Edit notes، ويحفظ Save team notes تغييرك، وإذا حفظ أحد قبلك فأعد تحميل نسخته ثم أعد تغييرك. وتُمسح الملاحظة بعد 180 يومًا من آخر تعديل. وهي ترفض كل ما يشبه عنوان بريد إلكتروني أو رقم هاتف: أي سلسلة من 8 أرقام أو أكثر، حتى لو فصلت بينها مسافات أو نقاط أو شرطات أو أقواس. فاحتفظ ببيانات العملاء في شاشة العملاء المحتملين حيث تكون محمية."
        },
        {
          "t": "tip",
          "x": "يقرأ ملاحظات الفريق كل من يرى لوحة التحكم، فلا تكتب فيها ما لا تقوله للفريق كله."
        }
      ]
    }
  },
  {
    "slug": "your-account",
    "sort_order": 20,
    "minutes": 3,
    "tags": [
      "account",
      "basics"
    ],
    "screens": [
      "/admin/account",
      "/admin/notifications"
    ],
    "caps": [],
    "title": "Your account, password and bell",
    "title_ar": "حسابك وكلمة المرور والإشعارات",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Your account holds your display name (shown at the bottom of the menu and, to Admins, in Users & roles), your password, and a plain list of what your role can do. Open it from your name at the bottom of the menu."
        },
        {
          "t": "h",
          "x": "Changing your password"
        },
        {
          "t": "ol",
          "x": [
            "Type your current password, then the new one twice. A new password has at least 10 characters.",
            "Five wrong current passwords within 15 minutes lock your account for 15 minutes, as on the sign-in page.",
            "Once the change goes through, every other device you are signed in on is signed out. This one stays signed in."
          ]
        },
        {
          "t": "h",
          "x": "Your e-mail address"
        },
        {
          "t": "p",
          "x": "Changing it needs outgoing e-mail, which is not set up yet, so your account shows Not set up for now."
        },
        {
          "t": "h",
          "x": "The bell"
        },
        {
          "t": "ol",
          "x": [
            "It shows up to 30 items from the last 14 days: new inquiries and job applications for the roles that handle them, services and posts going live today for the roles that write them, and maintenance switched on or off for everyone.",
            "Mark all as read marks what you were shown. Anything that arrives while the list is open stays new."
          ]
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "يضم حسابك اسم العرض (ويظهر أسفل القائمة، وللمسؤولين في Users & roles)، وكلمة المرور، وقائمة واضحة بما يستطيع دورك فعله. افتحه من اسمك أسفل القائمة."
        },
        {
          "t": "h",
          "x": "تغيير كلمة المرور"
        },
        {
          "t": "ol",
          "x": [
            "اكتب كلمة المرور الحالية، ثم الجديدة مرتين. يجب ألا تقل كلمة المرور الجديدة عن 10 أحرف.",
            "خمس محاولات خاطئة لكلمة المرور الحالية خلال 15 دقيقة تقفل حسابك 15 دقيقة، كما في صفحة تسجيل الدخول.",
            "بعد نجاح التغيير يُسجَّل خروجك من كل جهاز آخر كنت مسجّلًا فيه، ويبقى هذا الجهاز مسجّلًا."
          ]
        },
        {
          "t": "h",
          "x": "بريدك الإلكتروني"
        },
        {
          "t": "p",
          "x": "يحتاج تغييره إلى خدمة إرسال البريد، وهي غير مُعدّة بعد، لذلك يظهر في حسابك Not set up حاليًا."
        },
        {
          "t": "h",
          "x": "الجرس"
        },
        {
          "t": "ol",
          "x": [
            "يعرض حتى 30 عنصرًا من آخر 14 يومًا: الاستفسارات الجديدة وطلبات التوظيف للأدوار التي تتولاها، والخدمات والمقالات التي تُنشر اليوم للأدوار التي تكتبها، وتشغيل وضع الصيانة أو إيقافه للجميع.",
            "يحدّد Mark all as read ما عُرض عليك كمقروء، وما يصل أثناء فتح القائمة يبقى جديدًا."
          ]
        }
      ]
    }
  },
  {
    "slug": "roles-and-access",
    "sort_order": 30,
    "minutes": 4,
    "tags": [
      "account",
      "team"
    ],
    "screens": [
      "/admin/account",
      "/admin/users"
    ],
    "caps": [],
    "title": "Roles: who can do what",
    "title_ar": "الأدوار: من يستطيع فعل ماذا",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "There are four roles. Each sees only the screens it can use, and the server checks the role again on every save, so a hidden button is never the only lock."
        },
        {
          "t": "ol",
          "x": [
            "Admin: everything, including people and their roles, archiving and deleting, and job applications.",
            "Content Creator: writes and publishes the site's content (services, projects, posts, pages, testimonials and the rest) and manages media. No settings and no leads.",
            "SEO: SEO defaults, redirects, integrations, and the website and search stats. It can open pages, services, projects and posts without changing their content.",
            "Developer: general settings, maintenance, the theme editor (saved themes do not change the site yet), media, leads, site health, logs and the activity log. It does not write or publish content, and it cannot see job applications."
          ]
        },
        {
          "t": "h",
          "x": "Changing someone's role"
        },
        {
          "t": "p",
          "x": "Only an Admin can, in Settings › Users & roles: open the person, choose the role or switch off Can sign in, and save. That ends every sign-in the person has, on every device: the admin turns them away at their next click, and they sign in again to get the new role. You cannot change your own role or switch yourself off."
        },
        {
          "t": "p",
          "x": "One limit to know: a sign-in pass already handed out keeps working for up to an hour when someone uses it directly against the database, outside the admin. On settings, media, the system logs and content it still carries the role it was issued with until it runs out. People and their roles, the security settings, leads, job applications and the activity log check the person's account on every request, so those close at once."
        },
        {
          "t": "h",
          "x": "The account owner"
        },
        {
          "t": "p",
          "x": "One Admin is the account owner, marked by whoever runs the database. The owner always keeps the Admin role: nobody can change it, switch the owner off or remove them. To hand ownership on, the owner opens another active Admin and chooses Make account owner."
        },
        {
          "t": "h",
          "x": "Security settings"
        },
        {
          "t": "p",
          "x": "The Security card on Users & roles sets the session length, 1 day or 7 days: someone who signed in longer ago than that is asked to sign in again at their next click. It also sets the allowed email domain: when it is filled in, invites go only to addresses at that domain."
        },
        {
          "t": "tip",
          "x": "Roles are fixed: there are no exceptions for one person. If someone needs more, they need a different role."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "هناك أربعة أدوار. يرى كل دور الشاشات التي يستطيع استخدامها فقط، ويتحقق الخادم من الدور مرة أخرى عند كل حفظ، فلا يكون إخفاء الزر هو القفل الوحيد أبدًا."
        },
        {
          "t": "ol",
          "x": [
            "Admin (مسؤول): كل شيء، بما في ذلك الأشخاص وأدوارهم، والأرشفة والحذف، وطلبات التوظيف.",
            "Content Creator (صانع محتوى): يكتب محتوى الموقع وينشره (الخدمات والمشاريع والمقالات والصفحات والتوصيات وغيرها) ويدير الوسائط. لا إعدادات ولا عملاء محتملين.",
            "SEO (تحسين محركات البحث): إعدادات SEO الافتراضية، وإعادة التوجيه، والتكاملات، وإحصاءات الموقع والبحث. يستطيع فتح الصفحات والخدمات والمشاريع والمقالات دون تغيير محتواها.",
            "Developer (مطوّر): الإعدادات العامة، ووضع الصيانة، ومحرر المظهر (لا تغيّر المظاهر المحفوظة الموقع بعد)، والوسائط، والعملاء المحتملون، وصحة الموقع، والسجلات، وسجل النشاط. لا يكتب المحتوى ولا ينشره، ولا يرى طلبات التوظيف."
          ]
        },
        {
          "t": "h",
          "x": "تغيير دور شخص ما"
        },
        {
          "t": "p",
          "x": "يستطيع ذلك المسؤول (Admin) فقط، من Settings › Users & roles: افتح حساب الشخص، واختر الدور أو أوقف Can sign in، ثم احفظ. يُنهي ذلك كل جلسات دخول الشخص على كل أجهزته: ترفضه لوحة الإدارة عند نقرته التالية، ثم يسجّل دخوله من جديد ليحصل على الدور الجديد. لا يمكنك تغيير دورك بنفسك ولا إيقاف حسابك."
        },
        {
          "t": "p",
          "x": "وهناك حدّ ينبغي معرفته: تصريح الدخول الذي صدر بالفعل يبقى صالحًا حتى ساعة إذا استُخدم مباشرة على قاعدة البيانات، خارج لوحة الإدارة. ففي الإعدادات والوسائط وسجلات النظام والمحتوى يبقى يحمل الدور الذي صدر به إلى أن ينتهي. أما الأشخاص وأدوارهم، وإعدادات الأمان، والعملاء المحتملون، وطلبات التوظيف، وسجل النشاط فتتحقق من حساب الشخص عند كل طلب، فيُغلق الوصول إليها فورًا."
        },
        {
          "t": "h",
          "x": "مالك الحساب"
        },
        {
          "t": "p",
          "x": "أحد المسؤولين هو مالك الحساب، ويحدّده من يدير قاعدة البيانات. يحتفظ المالك بدور Admin دائمًا: لا يستطيع أحد تغييره أو إيقاف حساب المالك أو حذفه. ولنقل الملكية، يفتح المالك حساب مسؤول آخر نشط ويختار Make account owner."
        },
        {
          "t": "h",
          "x": "إعدادات الأمان"
        },
        {
          "t": "p",
          "x": "تحدّد بطاقة Security في Users & roles مدة الجلسة، يومًا واحدًا أو 7 أيام: من سجّل دخوله قبل أكثر من ذلك يُطلب منه تسجيل الدخول من جديد عند نقرته التالية. وتحدّد أيضًا نطاق البريد الإلكتروني المسموح به: إذا مُلئ، لا تُرسل الدعوات إلا إلى عناوين ذلك النطاق."
        },
        {
          "t": "tip",
          "x": "الأدوار ثابتة، ولا استثناءات لشخص بعينه. من يحتاج إلى صلاحيات أكثر يحتاج إلى دور مختلف."
        }
      ]
    }
  },
  {
    "slug": "inviting-people",
    "sort_order": 35,
    "minutes": 2,
    "tags": [
      "team"
    ],
    "screens": [
      "/admin/users"
    ],
    "caps": [
      "users.manage"
    ],
    "title": "Inviting people",
    "title_ar": "دعوة الأشخاص",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Only an Admin can invite people. In Settings › Users & roles, choose Invite someone, enter their email and role, and if you like their name and a short message (up to 300 characters) that appears in the email."
        },
        {
          "t": "ol",
          "x": [
            "They get an email with a link to set their password. The link works for one hour. If it runs out, choose Resend on their row under Pending invites.",
            "They choose a password of at least 10 characters, then sign in with their email and that password. Their role is the one you chose.",
            "Until they have accepted the invite, you can Cancel it: the link stops working and the account is removed. After that, use Remove access instead.",
            "When an allowed email domain is set in Security, invites and resends go only to addresses at exactly that domain."
          ]
        },
        {
          "t": "h",
          "x": "Before email is set up"
        },
        {
          "t": "p",
          "x": "Invites need the site to send email. Until that is connected, Invite someone and Resend say Not set up and send nothing. Pending invites, Cancel and the rest of the screen still work."
        },
        {
          "t": "tip",
          "x": "Every invite, resend, cancelled invite and accepted invite is recorded in the activity log, without their email or your message."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "يستطيع المسؤول (Admin) وحده دعوة الأشخاص. من Settings › Users & roles اختر Invite someone، وأدخل البريد الإلكتروني للشخص ودوره، ويمكنك إضافة اسمه ورسالة قصيرة (حتى 300 حرف) تظهر في الرسالة الإلكترونية."
        },
        {
          "t": "ol",
          "x": [
            "تصله رسالة بريد إلكتروني فيها رابط لاختيار كلمة المرور. يعمل الرابط ساعة واحدة، وإذا انتهت مدته فاختر Resend في صفه ضمن Pending invites.",
            "يختار كلمة مرور من 10 أحرف على الأقل، ثم يسجّل الدخول ببريده الإلكتروني وكلمة المرور تلك، ويحصل على الدور الذي اخترته.",
            "ما دام لم يقبل الدعوة بعد، يمكنك إلغاءها بزر Cancel: يتوقف الرابط عن العمل ويُحذف الحساب. وبعد ذلك استخدم Remove access بدلًا منه.",
            "إذا حُدّد نطاق بريد مسموح به في بطاقة Security، فلا تُرسل الدعوات ولا يُعاد إرسالها إلا إلى عناوين ذلك النطاق بالضبط."
          ]
        },
        {
          "t": "h",
          "x": "قبل إعداد البريد الإلكتروني"
        },
        {
          "t": "p",
          "x": "تحتاج الدعوات إلى أن يرسل الموقع رسائل بريد إلكتروني. وإلى أن يُربط ذلك، يظهر Not set up على Invite someone وResend ولا يُرسل شيء. أما Pending invites وCancel وبقية الشاشة فتعمل كالمعتاد."
        },
        {
          "t": "tip",
          "x": "تُسجَّل في سجل النشاط كل دعوة وكل إعادة إرسال وكل دعوة أُلغيت أو قُبلت، دون بريد الشخص الإلكتروني أو رسالتك."
        }
      ]
    }
  },
  {
    "slug": "saving-and-publishing",
    "sort_order": 40,
    "minutes": 4,
    "tags": [
      "content"
    ],
    "screens": [
      "/admin/pages",
      "/admin/sections",
      "/admin/services",
      "/admin/disciplines",
      "/admin/service-cases",
      "/admin/portfolio",
      "/admin/sectors",
      "/admin/blog",
      "/admin/categories",
      "/admin/testimonials",
      "/admin/clients",
      "/admin/team",
      "/admin/statistics",
      "/admin/certifications",
      "/admin/navigation"
    ],
    "caps": [
      "pages.write",
      "services.write",
      "portfolio.write",
      "blog.write",
      "nav.edit",
      "categories.manage"
    ],
    "title": "Saving, publishing and scheduling",
    "title_ar": "الحفظ والنشر والجدولة",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Every editor works the same way: change the fields, then press Save changes. What you save is what the site shows, so a change to something already published is live as soon as it is saved."
        },
        {
          "t": "h",
          "x": "Status"
        },
        {
          "t": "p",
          "x": "Most items have a status:"
        },
        {
          "t": "ol",
          "x": [
            "Draft: saved, not on the site.",
            "Scheduled: goes live by itself within five minutes of its Scheduled for time. Team, Statistics and Certifications have no Scheduled for field, so there Scheduled keeps an item off the site until you set it to Published.",
            "Published: on the site.",
            "Archived: off the site and kept. Only an Admin can archive or delete."
          ]
        },
        {
          "t": "h",
          "x": "If someone else saved first"
        },
        {
          "t": "p",
          "x": "When a colleague saves the same item while you are editing it, your save is stopped with a message instead of overwriting their work. Reload to see their version, then make your change again."
        },
        {
          "t": "h",
          "x": "Both languages"
        },
        {
          "t": "p",
          "x": "The site is in English and Arabic, so most text fields come in pairs. Fill both, so Arabic visitors see the same page as English ones."
        },
        {
          "t": "tip",
          "x": "An item marked Placeholder (design sample), or Design placeholder on a page section, came with the design delivery. On the live site it cannot be published or shown until you replace its content and untick the box, unless the site's owner has allowed design samples for that kind of item."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تعمل جميع المحررات بالطريقة نفسها: عدّل الحقول ثم اضغط Save changes. ما تحفظه هو ما يعرضه الموقع، لذا يظهر أي تغيير على محتوى منشور فور حفظه."
        },
        {
          "t": "h",
          "x": "الحالة"
        },
        {
          "t": "p",
          "x": "لمعظم العناصر حالة:"
        },
        {
          "t": "ol",
          "x": [
            "Draft (مسودة): محفوظ، وليس على الموقع.",
            "Scheduled (مجدول): يُنشر تلقائيًا خلال خمس دقائق من وقت Scheduled for. ولا يوجد حقل Scheduled for في Team وStatistics وCertifications، لذا تُبقي حالة Scheduled العنصر هناك خارج الموقع حتى تجعله Published.",
            "Published (منشور): على الموقع.",
            "Archived (مؤرشف): أُزيل من الموقع مع الاحتفاظ به. الأرشفة والحذف للمسؤول (Admin) فقط."
          ]
        },
        {
          "t": "h",
          "x": "إذا حفظ أحد قبلك"
        },
        {
          "t": "p",
          "x": "إذا حفظ زميل العنصر نفسه أثناء تعديلك له، يتوقف حفظك برسالة بدل أن يكتب فوق عمله. أعد تحميل الصفحة لترى نسخته، ثم أعد تعديلك."
        },
        {
          "t": "h",
          "x": "اللغتان"
        },
        {
          "t": "p",
          "x": "الموقع باللغتين الإنجليزية والعربية، لذا تأتي معظم الحقول النصية في أزواج. املأ الاثنين ليرى زوار العربية الصفحة نفسها التي يراها زوار الإنجليزية."
        },
        {
          "t": "tip",
          "x": "العنصر المعلَّم بـ Placeholder (design sample)، أو بـ Design placeholder في أقسام الصفحات، جاء مع تسليم التصميم. ولا يمكن نشره أو عرضه على الموقع المباشر حتى تستبدل محتواه وتزيل العلامة، إلا إذا سمح مالك الموقع بعرض عينات التصميم لهذا النوع من العناصر."
        }
      ]
    }
  },
  {
    "slug": "media-library",
    "sort_order": 50,
    "minutes": 2,
    "tags": [
      "content",
      "media"
    ],
    "screens": [
      "/admin/media"
    ],
    "caps": [
      "media.write"
    ],
    "title": "The media library and alt text",
    "title_ar": "مكتبة الوسائط والنص البديل",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "The media library lists the images, videos and files the site uses. Each keeps its alt text: the short description screen readers read aloud and search engines index."
        },
        {
          "t": "ol",
          "x": [
            "Every image needs alt text in English and Arabic. Say what the image shows in a sentence, not the file name.",
            "Folders and tags help you find things here. Visitors never see them.",
            "Only an Admin can delete an asset for good, and only once nothing on the site uses it."
          ]
        },
        {
          "t": "tip",
          "x": "Good alt text helps twice: people using a screen reader hear it, and search engines read it."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تعرض مكتبة الوسائط الصور والفيديوهات والملفات التي يستخدمها الموقع، ولكل منها نص بديل: وصف قصير تقرؤه برامج قراءة الشاشة بصوت عالٍ وتفهرسه محركات البحث."
        },
        {
          "t": "ol",
          "x": [
            "تحتاج كل صورة إلى نص بديل بالإنجليزية والعربية. صف ما تُظهره الصورة في جملة، لا اسم الملف.",
            "تساعدك المجلدات والوسوم على إيجاد الملفات هنا، ولا يراها الزوار أبدًا.",
            "حذف الملف نهائيًا للمسؤول (Admin) فقط، وفقط حين لا يستخدمه أي جزء من الموقع."
          ]
        },
        {
          "t": "tip",
          "x": "النص البديل الجيد يفيد مرتين: يسمعه من يستخدم قارئ الشاشة، وتقرؤه محركات البحث."
        }
      ]
    }
  },
  {
    "slug": "seo-and-redirects",
    "sort_order": 60,
    "minutes": 4,
    "tags": [
      "seo"
    ],
    "screens": [
      "/admin/seo",
      "/admin/redirects"
    ],
    "caps": [
      "seo.globalDefaults",
      "redirects.manage"
    ],
    "title": "SEO defaults and redirects",
    "title_ar": "إعدادات SEO الافتراضية وإعادة التوجيه",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "SEO defaults are the titles, descriptions and link-preview image that search engines and social sites see wherever a page has none of its own. Set them once, the text in both languages."
        },
        {
          "t": "h",
          "x": "Redirects"
        },
        {
          "t": "p",
          "x": "A redirect sends visitors and search engines from an old address to a new one, so links shared before a rename keep working."
        },
        {
          "t": "ol",
          "x": [
            "From is the old path, such as /old-page. A path that still shows a page is refused: a redirect only covers addresses that would otherwise find nothing.",
            "To is where it leads: a path on this site or a full https:// address. Point at the final address, because a redirect to another redirect is refused.",
            "301 is a permanent move and 302 a temporary one. 308 is permanent too, for addresses that receive forms.",
            "A rule takes effect within a minute of saving, and a rule for an English path also covers its Arabic twin under /ar."
          ]
        },
        {
          "t": "tip",
          "x": "Browsers can remember a permanent redirect for up to a day. If you are not sure a move is final, start with 302: it can be changed or removed at once."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "إعدادات SEO الافتراضية هي العناوين والأوصاف وصورة معاينة الروابط التي تراها محركات البحث ومواقع التواصل حيثما لا تملك الصفحة ما يخصها. اضبطها مرة واحدة، والنصوص باللغتين."
        },
        {
          "t": "h",
          "x": "إعادة التوجيه"
        },
        {
          "t": "p",
          "x": "تنقل إعادة التوجيه الزوار ومحركات البحث من عنوان قديم إلى عنوان جديد، فتبقى الروابط التي تمت مشاركتها قبل تغيير الاسم صالحة."
        },
        {
          "t": "ol",
          "x": [
            "From هو المسار القديم، مثل /old-page. يُرفض المسار الذي ما زال يعرض صفحة، فإعادة التوجيه تغطي فقط العناوين التي لن تجد شيئًا بدونها.",
            "To هو الوجهة: مسار في هذا الموقع أو عنوان كامل يبدأ بـ https://. وجّهها إلى العنوان النهائي، لأن إعادة التوجيه إلى إعادة توجيه أخرى تُرفض.",
            "301 نقل دائم و302 نقل مؤقت، و308 نقل دائم أيضًا للعناوين التي تستقبل النماذج.",
            "تسري القاعدة خلال دقيقة من الحفظ، والقاعدة الخاصة بمسار إنجليزي تشمل نظيره العربي تحت /ar."
          ]
        },
        {
          "t": "tip",
          "x": "قد تتذكر المتصفحات إعادة التوجيه الدائمة حتى يوم كامل. إن لم تكن متأكدًا من أن النقل نهائي فابدأ بـ 302، إذ يمكن تغييرها أو حذفها فورًا."
        }
      ]
    }
  },
  {
    "slug": "working-with-leads",
    "sort_order": 70,
    "minutes": 3,
    "tags": [
      "leads"
    ],
    "screens": [
      "/admin/leads"
    ],
    "caps": [
      "leads.manage"
    ],
    "title": "Working with leads",
    "title_ar": "التعامل مع العملاء المحتملين",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Every inquiry sent through the site's contact forms arrives here as a lead. The list shows when it came in, the person's name and what they asked about. Contact details stay hidden until you ask for them."
        },
        {
          "t": "ol",
          "x": [
            "Set each lead's status as you work on it: new, in progress, done or spam. The filter above the list shows one status at a time.",
            "View opens the message. Reveal contact details and notes shows the e-mail, phone, budget and timeline. Each reveal is logged against your account, up to 60 an hour.",
            "Internal notes appear after a reveal, for the roles that may see contact details.",
            "Export CSV downloads the leads as a file, at most three times an hour. Every export is logged."
          ]
        },
        {
          "t": "tip",
          "x": "A lead marked as spam is deleted sooner: after 30 days by default, instead of 24 months."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "يصل هنا كل استفسار يُرسل عبر نماذج التواصل في الموقع على هيئة عميل محتمل. تعرض القائمة وقت وصوله واسم صاحبه وما سأل عنه، وتبقى بيانات التواصل مخفية حتى تطلبها."
        },
        {
          "t": "ol",
          "x": [
            "حدّد حالة كل عميل محتمل أثناء العمل عليه: new أو in progress أو done أو spam. ويعرض المرشّح أعلى القائمة حالة واحدة في كل مرة.",
            "يفتح View الرسالة، ويُظهر Reveal contact details and notes البريد الإلكتروني والهاتف والميزانية والمدة الزمنية. يُسجَّل كل كشف باسم حسابك، بحد أقصى 60 مرة في الساعة.",
            "تظهر الملاحظات الداخلية بعد الكشف، للأدوار المخوّلة برؤية بيانات التواصل.",
            "ينزّل Export CSV العملاء المحتملين في ملف، بحد أقصى ثلاث مرات في الساعة، ويُسجَّل كل تصدير."
          ]
        },
        {
          "t": "tip",
          "x": "العميل المحتمل المعلَّم كرسالة مزعجة (spam) يُحذف أسرع: بعد 30 يومًا افتراضيًا بدلًا من 24 شهرًا."
        }
      ]
    }
  },
  {
    "slug": "personal-data",
    "sort_order": 80,
    "minutes": 4,
    "tags": [
      "privacy",
      "leads",
      "hiring"
    ],
    "screens": [
      "/admin/leads",
      "/admin/applications"
    ],
    "caps": [
      "leads.pii",
      "applications.pii"
    ],
    "title": "Personal data and the PDPL",
    "title_ar": "البيانات الشخصية ونظام حمايتها",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Saudi Arabia's Personal Data Protection Law (PDPL) covers everything visitors send through the site. The admin makes the careful way the default, so there is little to remember."
        },
        {
          "t": "ol",
          "x": [
            "Contact details are stored encrypted. They are shown one person at a time, only when you ask, and each look is recorded against your account, with the time.",
            "Visits are counted only for visitors who accept analytics cookies on the site.",
            "Leads are deleted after 24 months by default, spam after 30 days. Job applications go after 12 months, or 24 if the applicant agreed to be kept for future roles.",
            "Exports and CV downloads are logged too, and exports are limited per hour.",
            "When an applicant asks for their data to be deleted, an Admin can erase the application, CV included."
          ]
        },
        {
          "t": "tip",
          "x": "Reveal contact details only when you are about to get in touch. Each look is recorded against the account that made it, and the activity log lists it with its time and that account's role."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "يشمل نظام حماية البيانات الشخصية في المملكة العربية السعودية كل ما يرسله الزوار عبر الموقع. وتجعل لوحة الإدارة الطريقة الحذرة هي الطريقة الافتراضية، فلا يبقى الكثير لتتذكره."
        },
        {
          "t": "ol",
          "x": [
            "تُحفظ بيانات التواصل مشفّرة، وتُعرض بيانات شخص واحد في كل مرة وعند طلبك فقط، ويُسجَّل كل اطلاع على حسابك مع وقته.",
            "لا تُحتسب الزيارات إلا لمن يقبل من الزوار ملفات تعريف الارتباط الخاصة بالتحليلات.",
            "يُحذف العملاء المحتملون بعد 24 شهرًا افتراضيًا، والرسائل المزعجة بعد 30 يومًا. وتُحذف طلبات التوظيف بعد 12 شهرًا، أو 24 شهرًا إذا وافق المتقدم على الاحتفاظ بطلبه لوظائف مستقبلية.",
            "يُسجَّل التصدير وتنزيل السير الذاتية أيضًا، ولعمليات التصدير حد في الساعة.",
            "عندما يطلب متقدم حذف بياناته، يستطيع المسؤول (Admin) محو طلبه بما فيه سيرته الذاتية."
          ]
        },
        {
          "t": "tip",
          "x": "اكشف بيانات التواصل فقط حين توشك على التواصل. يُسجَّل كل اطلاع على الحساب الذي قام به، ويعرضه سجل النشاط مع وقته ودور ذلك الحساب."
        }
      ]
    }
  },
  {
    "slug": "job-applications",
    "sort_order": 90,
    "minutes": 3,
    "tags": [
      "hiring"
    ],
    "screens": [
      "/admin/applications"
    ],
    "caps": [
      "applications.manage"
    ],
    "title": "Job applications",
    "title_ar": "طلبات التوظيف",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Applications sent from the Join page arrive here. The form on the site is open only while Accepting job applications is ticked in General settings, which only an Admin can change."
        },
        {
          "t": "ol",
          "x": [
            "Set each application's status as you review it.",
            "Reveal contact details shows the e-mail and phone, and Download CV fetches the file. Both are logged against your account.",
            "Erase application removes the application and its CV for good. Use it when someone asks for their data to be deleted.",
            "Applications are kept 12 months, or 24 if the applicant agreed to be considered for future roles. One marked spam goes after 30 days."
          ]
        },
        {
          "t": "tip",
          "x": "CVs are not scanned for viruses. Open them with care, and keep them inside the team."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تصل هنا الطلبات المرسلة من صفحة Join. ولا يكون النموذج في الموقع مفتوحًا إلا عند تفعيل Accepting job applications في الإعدادات العامة، وتغييره للمسؤول (Admin) فقط."
        },
        {
          "t": "ol",
          "x": [
            "حدّد حالة كل طلب أثناء مراجعته.",
            "يُظهر Reveal contact details البريد الإلكتروني والهاتف، ويجلب Download CV الملف، ويُسجَّل الاثنان باسم حسابك.",
            "يحذف Erase application الطلب وسيرته الذاتية نهائيًا. استخدمه عندما يطلب أحد حذف بياناته.",
            "تُحفظ الطلبات 12 شهرًا، أو 24 شهرًا إذا وافق المتقدم على النظر في طلبه لوظائف مستقبلية. والطلب المعلَّم كرسالة مزعجة (spam) يُحذف بعد 30 يومًا."
          ]
        },
        {
          "t": "tip",
          "x": "لا تُفحص السير الذاتية بحثًا عن الفيروسات. افتحها بحذر وأبقِها داخل الفريق."
        }
      ]
    }
  },
  {
    "slug": "maintenance-mode",
    "sort_order": 100,
    "minutes": 2,
    "tags": [
      "site"
    ],
    "screens": [
      "/admin/maintenance"
    ],
    "caps": [
      "maintenance.manage"
    ],
    "title": "Maintenance mode",
    "title_ar": "وضع الصيانة",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Maintenance mode puts a short notice in front of the public site while you fix something. It takes effect within about a minute, and the admin keeps working as usual."
        },
        {
          "t": "ol",
          "x": [
            "Tick Maintenance mode is on and save. Visitors see the maintenance notice instead of the site.",
            "To keep seeing the real site yourself, add your IP address to the allowlist, one per line.",
            "While it is on, everyone in the admin sees Maintenance on in the top bar, and the bell says when it was switched on or off.",
            "Untick it and save to bring the site back."
          ]
        },
        {
          "t": "tip",
          "x": "Switch it off as soon as the fix is in, so visitors and search engines are not kept waiting."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "يضع وضع الصيانة إشعارًا قصيرًا أمام الموقع العام أثناء إصلاحك لشيء ما. يسري خلال دقيقة تقريبًا، وتستمر لوحة الإدارة في العمل كالمعتاد."
        },
        {
          "t": "ol",
          "x": [
            "فعّل Maintenance mode is on واحفظ، فيرى الزوار إشعار الصيانة بدل الموقع.",
            "لتواصل رؤية الموقع الحقيقي بنفسك، أضف عنوان IP الخاص بك إلى قائمة السماح، عنوانًا في كل سطر.",
            "أثناء تفعيله يرى الجميع في لوحة الإدارة Maintenance on في الشريط العلوي، ويُعلمك الجرس بوقت تشغيله أو إيقافه.",
            "ألغِ التفعيل واحفظ لإعادة الموقع."
          ]
        },
        {
          "t": "tip",
          "x": "أوقفه فور انتهاء الإصلاح، حتى لا يطول انتظار الزوار ومحركات البحث."
        }
      ]
    }
  },
  {
    "slug": "page-visibility",
    "sort_order": 105,
    "minutes": 2,
    "tags": [
      "site"
    ],
    "screens": [
      "/admin/visibility"
    ],
    "caps": [
      "maintenance.manage"
    ],
    "title": "Page visibility",
    "title_ar": "ظهور الصفحات",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Page visibility decides who can see each page of the public site. A change applies to the live site within a few minutes, and the admin keeps working as usual."
        },
        {
          "t": "ol",
          "x": [
            "Visible to everyone is the normal setting: the page is in the menus and in search engines, and open to all.",
            "Hidden from the site takes the page out of the menus, the sitemap and search engines. Anyone who opens its link is sent to the page you choose, or sees a page not found screen.",
            "Hiding is not deleting: the page's words stay published. Unpublish it, or keep confidential details off it. A hidden Join or Contact page still takes what its form sends: to stop job applications, turn off Accepting job applications in General settings.",
            "To hide a page for a while, give it a Hide from day, a Show again on day, or both. It is hidden from the start of the first day until the start of the second, Riyadh time. Leave both empty to hide it until you show it again.",
            "Only people with the link keeps the page out of the menus, the sitemap and search engines, but the link still works. It is unlisted, not private: anyone who has the link can open it, so keep anything confidential off it.",
            "The service page and the case study page are templates. Hiding one hides every service page, or every project page, at once. To hide a single service or project, unpublish that item instead.",
            "The homepage is always visible. To take the whole site down for a while, use maintenance mode.",
            "If a save says the live site has not picked it up, press Sync to edge. The line above the list says whether the live site has the settings."
          ]
        },
        {
          "t": "tip",
          "x": "Search engines and AI tools that fetched the sitemap just before a change may keep the old list for up to an hour."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "يحدد ظهور الصفحات من يستطيع رؤية كل صفحة من صفحات الموقع العام. يسري التغيير على الموقع المباشر خلال بضع دقائق، وتستمر لوحة الإدارة في العمل كالمعتاد."
        },
        {
          "t": "ol",
          "x": [
            "الخيار المعتاد هو Visible to everyone: تظهر الصفحة في القوائم وفي محركات البحث، ويستطيع الجميع فتحها.",
            "يُخرج خيار Hidden from the site الصفحة من القوائم وخريطة الموقع ومحركات البحث. ومن يفتح رابطها يُنقل إلى الصفحة التي تختارها، أو تظهر له صفحة تقول إن الصفحة غير موجودة.",
            "الإخفاء ليس حذفًا: يبقى نص الصفحة منشورًا. ألغِ نشرها، أو لا تضع عليها أي معلومات سرية. وتظل صفحة Join أو Contact المخفية تستقبل ما يُرسَل عبر نموذجها: لإيقاف طلبات التوظيف، أوقف خيار Accepting job applications في General settings.",
            "لإخفاء صفحة مدة محددة، حدّد لها يوم Hide from أو يوم Show again on أو كليهما. تبقى مخفية من بداية اليوم الأول حتى بداية اليوم الثاني بتوقيت الرياض. اترك الحقلين فارغين لإخفائها حتى تعيد إظهارها.",
            "يُبقي خيار Only people with the link الصفحة خارج القوائم وخريطة الموقع ومحركات البحث، لكن رابطها يظل يعمل. فهي غير مدرجة وليست خاصة: يستطيع فتحها كل من لديه الرابط، فلا تضع عليها أي معلومات سرية.",
            "صفحة الخدمة وصفحة دراسة الحالة قالبان، وإخفاء أحدهما يخفي كل صفحات الخدمات أو كل صفحات المشاريع دفعة واحدة. ولإخفاء خدمة واحدة أو مشروع واحد، ألغِ نشر ذلك العنصر بدلًا من ذلك.",
            "تظهر الصفحة الرئيسية دائمًا. ولإيقاف الموقع كله مؤقتًا استخدم وضع الصيانة.",
            "إذا ذكر الحفظ أن الموقع المباشر لم يستلم التغيير، فاضغط Sync to edge. ويذكر السطر أعلى القائمة إن كان الموقع المباشر قد استلم الإعدادات."
          ]
        },
        {
          "t": "tip",
          "x": "قد تحتفظ محركات البحث وأدوات الذكاء الاصطناعي التي جلبت خريطة الموقع قبيل التغيير بالقائمة القديمة مدة تصل إلى ساعة."
        }
      ]
    }
  },
  {
    "slug": "website-stats",
    "sort_order": 110,
    "minutes": 2,
    "tags": [
      "stats"
    ],
    "screens": [
      "/admin/analytics",
      "/admin/analytics/search"
    ],
    "caps": [
      "analytics.read"
    ],
    "title": "Website stats",
    "title_ar": "إحصاءات الموقع",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Website stats counts page views by page and by language. The numbers are the site's own, with no outside tracker, and only visitors who accept analytics cookies are counted."
        },
        {
          "t": "ol",
          "x": [
            "Pick 7, 30 or 90 days at the top. Overview shows page views, the Arabic share, English and Arabic views day by day and the top pages; Pages lists every page with its views in each language. If you work with leads, Overview also shows new leads and inquiries per 1,000 page views.",
            "A change against the previous period shows only when there is a previous period to compare: the same number of days just before.",
            "Counts are added up every 15 minutes, by days that run midnight to midnight UTC (3 am in Riyadh), so the latest visits can take a while to show.",
            "Where your role has a Search tab, it shows what visitors typed into the site's search, and which searches found nothing. A search that finds nothing is often a page worth writing.",
            "Raw visit records are kept 90 days; the daily totals the screen reads are kept after that."
          ]
        },
        {
          "t": "tip",
          "x": "A low number can simply mean few visitors accepted cookies, not few visitors."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تحتسب إحصاءات الموقع مشاهدات الصفحات حسب الصفحة واللغة. الأرقام خاصة بالموقع نفسه دون أي أداة تتبع خارجية، ولا يُحتسب إلا من يقبل من الزوار ملفات تعريف الارتباط الخاصة بالتحليلات."
        },
        {
          "t": "ol",
          "x": [
            "اختر 7 أو 30 أو 90 يومًا في الأعلى. يعرض تبويب Overview مشاهدات الصفحات وحصة العربية والمشاهدات بالإنجليزية والعربية يومًا بيوم وأكثر الصفحات زيارة، ويسرد تبويب Pages كل صفحة مع مشاهداتها بكل لغة. وإذا كنت تعمل على العملاء المحتملين فسيعرض Overview أيضًا العملاء الجدد والاستفسارات لكل 1,000 مشاهدة.",
            "لا يظهر التغيّر مقارنة بالفترة السابقة إلا إذا وُجدت فترة سابقة للمقارنة، أي العدد نفسه من الأيام التي تسبقها مباشرة.",
            "تُجمع الأرقام كل 15 دقيقة، بأيام تمتد من منتصف الليل إلى منتصف الليل بتوقيت UTC (الثالثة فجرًا بتوقيت الرياض)، لذا قد تتأخر أحدث الزيارات في الظهور.",
            "إذا كان لدورك تبويب Search فهو يعرض ما كتبه الزوار في بحث الموقع، وعمليات البحث التي لم تجد شيئًا. والبحث الذي لا يجد شيئًا كثيرًا ما يشير إلى صفحة تستحق الكتابة.",
            "تُحفظ سجلات الزيارات الأولية 90 يومًا، وتبقى المجاميع اليومية التي تقرؤها الشاشة بعد ذلك."
          ]
        },
        {
          "t": "tip",
          "x": "قد يعني الرقم المنخفض ببساطة أن قلة من الزوار قبلوا ملفات تعريف الارتباط، لا أن الزوار قليلون."
        }
      ]
    }
  },
  {
    "slug": "site-health-and-logs",
    "sort_order": 120,
    "minutes": 3,
    "tags": [
      "site"
    ],
    "screens": [
      "/admin/site-health",
      "/admin/audit"
    ],
    "caps": [
      "siteHealth.view",
      "logs.view",
      "audit.view"
    ],
    "title": "Site health, errors and the activity log",
    "title_ar": "صحة الموقع والأخطاء وسجل النشاط",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Site health shows how fast the site feels to real visitors (Core Web Vitals), measured in their own browsers when they accept analytics cookies, beside a checklist of things worth fixing."
        },
        {
          "t": "ol",
          "x": [
            "The score is half speed and half checklist. Speed comes from real visits over the last 28 days: each of LCP, INP and CLS counts in full when it is within budget, half when it needs work and not at all when it is poor. Uptime is not measured here yet.",
            "The checklist groups what it checks: content, SEO, speed, errors, security and backups. A row that needs fixing links to the screen where you fix it, and a row your role cannot check says so.",
            "Speed lists each page's figures from visitors' browsers, added up every hour and kept 400 days. Lab scores run in CI on every change, so none are shown here.",
            "Errors lists problems the site ran into. Every night, entries older than 30 days are deleted by themselves; an Admin can clear them sooner with Clear logs, choosing entries older than 7 days, older than 30 days, or all of them, and the clearing itself is recorded in the activity log.",
            "The activity log records saves, publishes, reveals of contact details, sign-ins and exports, each against the account that made it, with the time. The database itself writes who made an entry and when, so nobody can record something in someone else's name. Each entry names the person, former members included, and says what they did in plain words, with the names of the fields a save changed, never what they hold. Nobody can edit or delete an entry, not even an Admin, and the log is kept for good.",
            "Narrow the log to a kind of activity, a person or a range of days. Publishing finds publishes recorded since these filters arrived; earlier ones are listed as updates. Export downloads the entries that match as a spreadsheet file (CSV), up to three times an hour, and each download is recorded in the log too; the file names each item by its type and id, not its title. If the line above the list says the latest entries do not link up, tell whoever runs the site."
          ]
        },
        {
          "t": "tip",
          "x": "To find out when something changed, and who changed it, look in the activity log."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تُظهر صحة الموقع مدى سرعة الموقع كما يشعر بها الزوار الحقيقيون (Core Web Vitals)، وتُقاس في متصفحاتهم عندما يقبلون ملفات تعريف الارتباط الخاصة بالتحليلات، إلى جانب قائمة تحقق بما يستحق الإصلاح."
        },
        {
          "t": "ol",
          "x": [
            "نصف الدرجة للسرعة ونصفها لقائمة التحقق. تأتي السرعة من زيارات حقيقية خلال آخر 28 يومًا: يُحتسب كل من LCP وINP وCLS كاملًا إذا كان ضمن الحد المستهدف، ونصفه إذا احتاج إلى تحسين، ولا يُحتسب إذا كان ضعيفًا. ولا يُقاس وقت التشغيل هنا بعد.",
            "تجمع قائمة التحقق ما تفحصه في مجموعات: المحتوى وSEO والسرعة والأخطاء والأمان والنسخ الاحتياطية. والبند الذي يحتاج إلى إصلاح يرتبط بالشاشة التي تصلحه منها، والبند الذي لا يستطيع دورك فحصه يذكر ذلك.",
            "يعرض تبويب Speed أرقام كل صفحة من متصفحات الزوار، تُجمع كل ساعة وتُحفظ 400 يوم. أما درجات المختبر فتُشغَّل في CI مع كل تغيير، لذا لا تظهر هنا.",
            "يعرض تبويب Errors المشكلات التي واجهها الموقع. تُحذف كل ليلة الإدخالات الأقدم من 30 يومًا تلقائيًا، ويستطيع المسؤول (Admin) مسحها قبل ذلك بزر Clear logs، فيختار الإدخالات الأقدم من 7 أيام أو الأقدم من 30 يومًا أو كلها، ويُسجَّل المسح نفسه في سجل النشاط.",
            "يسجّل سجل النشاط الحفظ والنشر وكشف بيانات التواصل وتسجيل الدخول والتصدير، كلًّا على الحساب الذي قام به مع وقته. وتكتب قاعدة البيانات بنفسها صاحب كل إدخال ووقته، فلا يستطيع أحد أن يسجّل شيئًا باسم غيره. ويذكر كل إدخال اسم الشخص، ومنهم من غادر الفريق، وما فعله بكلمات واضحة، مع أسماء الحقول التي غيّرها الحفظ دون محتواها. ولا يستطيع أحد تعديل أي إدخال أو حذفه، ولا حتى المسؤول (Admin)، ويُحتفظ بالسجل دائمًا.",
            "ضيّق السجل حسب نوع النشاط أو الشخص أو مدة من الأيام. يجد مرشّح Publishing ما نُشر منذ إضافة هذه المرشّحات، ويظهر ما نُشر قبلها كتحديثات. ويُنزّل زر Export الإدخالات المطابقة في ملف جدول بيانات (CSV) حتى ثلاث مرات في الساعة، ويُسجَّل كل تنزيل في السجل أيضًا، ويذكر الملف كل عنصر بنوعه ومعرّفه لا بعنوانه. وإذا ذكر السطر أعلى القائمة أن أحدث الإدخالات لا تتصل كما ينبغي، فأبلغ المسؤول عن الموقع."
          ]
        },
        {
          "t": "tip",
          "x": "لمعرفة متى تغيّر شيء ومن قام بتغييره، ارجع إلى سجل النشاط."
        }
      ]
    }
  }
]
$help$::jsonb
$fn$;

-- CREATE OR REPLACE keeps the ACL; restated anyway (0046: no API role reads the set).
revoke all on function app.help_article_set() from public, anon, authenticated, service_role;

-- Every tenant gets the new guide and the changed one (app.seed_help_articles inserts a
-- guide it lacks and updates one only where it differs from the set, moving its version;
-- 0046).
do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform app.seed_help_articles(t.id);
  end loop;
end $$;

-- ---- Postconditions ---------------------------------------------------------------------
-- Each block says what it checks. Expressions are read as pg_get_expr prints them (each
-- operator in parentheses, each AND list in one pair; a function's schema printed only when
-- app is not on the search path, and current_role, a reserved word, quoted), so the patterns
-- allow both.
do $$
declare
  -- Every table privilege the server knows. MAINTAIN exists from PostgreSQL 17 (production
  -- runs 17.6, CI 15), and the privilege functions refuse the word on an older server.
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger']
    || case when current_setting('server_version_num')::int >= 170000
            then array['maintain'] else array[]::text[] end;
  v_tenant constant text := '\(tenant_id = (app\.)?effective_tenant_id\(\)\)';
  v_live_role constant text := '\( SELECT (app\.)?live_role\(\) AS live_role\)';
  v_rd_read constant text :=
    '^\(' || v_tenant || ' AND (app\.)?is_staff\(\) AND \(\(\(role\)::text = (app\.)?"?current_role"?\(\)\) OR (app\.)?role_manages_users\((app\.)?"?current_role"?\(\)\)\)\)$';
  v_rd_write constant text :=
    '^\(' || v_tenant || ' AND (app\.)?role_manages_users\(' || v_live_role || '\)\)$';
  v_rd_live constant text :=
    '^\(' || v_tenant || ' AND \(' || v_live_role || ' IS NOT NULL\)\)$';
  v_tn_read constant text :=
    '^\(' || v_tenant || ' AND (app\.)?role_analytics_read\(' || v_live_role || '\)\)$';
  v_rd_insert constant text[] := array['dashboard', 'quick_actions', 'role', 'tenant_id'];
  v_rd_update constant text[] := array['dashboard', 'quick_actions'];
  v_have text[];
  v_want text[];
  v_cols text[];
  v_bad text;
  v_set jsonb;
  t text;
  p text;
begin
  -- ---- The helpers this migration relies on answer as §5 says (0050, 0052).
  if not (app.role_manages_users('admin') and not app.role_manages_users('developer')
          and not app.role_manages_users('content_creator') and not app.role_manages_users('seo')
          and not app.role_manages_users(null)) then
    raise exception '0060: app.role_manages_users does not answer users.manage (Admin only)';
  end if;
  if not (app.role_analytics_read('admin') and app.role_analytics_read('content_creator')
          and app.role_analytics_read('seo') and app.role_analytics_read('developer')
          and not app.role_analytics_read('anon') and not app.role_analytics_read(null)) then
    raise exception '0060: app.role_analytics_read does not answer analytics.read (the four staff roles)';
  end if;
  if not exists (select 1 from pg_proc where oid = 'app.live_role()'::regprocedure and prosecdef)
     or not has_function_privilege('authenticated', 'app.live_role()', 'execute')
     or has_function_privilege('anon', 'app.live_role()', 'execute') then
    raise exception '0060: app.live_role() must be a SECURITY DEFINER that authenticated alone executes';
  end if;

  -- ---- RLS on and forced on both tables.
  foreach t in array array['public.admin_role_defaults', 'public.team_notes'] loop
    if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = t::regclass) then
      raise exception '0060: % is not ENABLE + FORCE row level security', t;
    end if;
  end loop;

  -- ---- Exactly these policies (name, command, kind and roles compared as a set).
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s %s %s %s', tablename, policyname, cmd, permissive, roles) as e
            from pg_policies
           where schemaname = 'public' and tablename in ('admin_role_defaults', 'team_notes')) s;
  v_want := array[
    'admin_role_defaults admin_role_defaults_delete DELETE PERMISSIVE {authenticated}',
    'admin_role_defaults admin_role_defaults_insert INSERT PERMISSIVE {authenticated}',
    'admin_role_defaults admin_role_defaults_live ALL RESTRICTIVE {authenticated}',
    'admin_role_defaults admin_role_defaults_read SELECT PERMISSIVE {authenticated}',
    'admin_role_defaults admin_role_defaults_update UPDATE PERMISSIVE {authenticated}',
    'team_notes team_notes_read SELECT PERMISSIVE {authenticated}'];
  select array_agg(w order by w) into v_want from unnest(v_want) as w;
  if v_have is distinct from v_want then
    raise exception '0060: the dashboard policies are %, expected %', v_have, v_want;
  end if;

  -- ---- Each side of each policy, read separately: the tenant predicate first, then the
  -- role test, on every side the command has; a side it does not have is absent.
  select string_agg(format('%s %s %s', x.tab, x.policy, x.side), ', '
                    order by x.tab, x.policy, x.side) into v_bad
    from (values ('admin_role_defaults', 'admin_role_defaults_read', 'using', v_rd_read),
                 ('admin_role_defaults', 'admin_role_defaults_read', 'with check', null),
                 ('admin_role_defaults', 'admin_role_defaults_insert', 'using', null),
                 ('admin_role_defaults', 'admin_role_defaults_insert', 'with check', v_rd_write),
                 ('admin_role_defaults', 'admin_role_defaults_update', 'using', v_rd_write),
                 ('admin_role_defaults', 'admin_role_defaults_update', 'with check', v_rd_write),
                 ('admin_role_defaults', 'admin_role_defaults_delete', 'using', v_rd_write),
                 ('admin_role_defaults', 'admin_role_defaults_delete', 'with check', null),
                 ('admin_role_defaults', 'admin_role_defaults_live', 'using', v_rd_live),
                 ('admin_role_defaults', 'admin_role_defaults_live', 'with check', v_rd_live),
                 ('team_notes', 'team_notes_read', 'using', v_tn_read),
                 ('team_notes', 'team_notes_read', 'with check', null))
           as x(tab, policy, side, pattern)
    left join pg_policies pol
      on pol.schemaname = 'public' and pol.tablename = x.tab and pol.policyname = x.policy
    cross join lateral (select case x.side when 'using' then pol.qual
                                           else pol.with_check end as expr) e
   where pol.policyname is null
      or (x.pattern is null and e.expr is not null)
      or (x.pattern is not null and coalesce(e.expr, '') !~ x.pattern);
  if v_bad is not null then
    raise exception '0060: dashboard policy expressions are not as stated: %', v_bad;
  end if;

  -- ---- Table privileges, as each API role holds them (directly or through a role it is a
  -- member of): exactly these, nothing else of v_privs, under either grant regime.
  select string_agg(format('%s %s %s', g.tab, g.who, g.priv), ', ' order by g.tab, g.who, g.priv)
    into v_bad
    from (select x.tab, x.who, pr.priv,
                 has_table_privilege(x.who::name, x.tab, pr.priv) as held,
                 pr.priv = any (x.allowed) as wanted
            from (values ('public.admin_role_defaults', 'public', array[]::text[]),
                         ('public.admin_role_defaults', 'anon', array[]::text[]),
                         ('public.admin_role_defaults', 'authenticated', array['select', 'delete']),
                         ('public.admin_role_defaults', 'service_role',
                          array['select', 'insert', 'update', 'delete']),
                         ('public.team_notes', 'public', array[]::text[]),
                         ('public.team_notes', 'anon', array[]::text[]),
                         ('public.team_notes', 'authenticated', array['select']),
                         ('public.team_notes', 'service_role',
                          array['select', 'insert', 'update', 'delete']))
                   as x(tab, who, allowed)
            cross join unnest(v_privs) as pr(priv)) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0060: wrong table privileges (table role privilege): %', v_bad;
  end if;

  -- ---- Each table's own ACL, grantee by grantee: the owner's, plus exactly the grants
  -- above. A grant to any other role (a later custom role, supabase_auth_admin) fails here.
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s %s', c.relname,
                        case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end,
                        lower(a.privilege_type)) as e
            from pg_class c
            cross join lateral aclexplode(c.relacl) a
           where c.oid in ('public.admin_role_defaults'::regclass, 'public.team_notes'::regclass)
             and a.grantee <> c.relowner) s;
  v_want := array['admin_role_defaults authenticated delete', 'admin_role_defaults authenticated select',
                  'admin_role_defaults service_role delete', 'admin_role_defaults service_role insert',
                  'admin_role_defaults service_role select', 'admin_role_defaults service_role update',
                  'team_notes authenticated select', 'team_notes service_role delete',
                  'team_notes service_role insert', 'team_notes service_role select',
                  'team_notes service_role update'];
  select array_agg(w order by w) into v_want from unnest(v_want) as w;
  if v_have is distinct from v_want then
    raise exception '0060: the dashboard tables are granted %, expected %', v_have, v_want;
  end if;

  -- ---- Column grants: exactly authenticated's INSERT on the preset's key and its two
  -- columns, and UPDATE on the two columns; none at all on team_notes.
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s %s %s', c.relname, att.attname,
                        case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end,
                        lower(a.privilege_type)) as e
            from pg_class c
            join pg_attribute att on att.attrelid = c.oid
            cross join lateral aclexplode(att.attacl) a
           where c.oid in ('public.admin_role_defaults'::regclass, 'public.team_notes'::regclass)
             and att.attnum > 0 and not att.attisdropped) s;
  select array_agg(e order by e) into v_want
    from (select format('admin_role_defaults %s authenticated insert', c) as e from unnest(v_rd_insert) c
          union all
          select format('admin_role_defaults %s authenticated update', c) from unnest(v_rd_update) c) s;
  if v_have is distinct from v_want then
    raise exception '0060: the dashboard column grants are %, expected %', v_have, v_want;
  end if;

  -- ---- Column privileges as held: PUBLIC and anon none on any column of either table; no
  -- one REFERENCES a column; staff write no column of team_notes; staff INSERT and UPDATE on
  -- admin_role_defaults exactly the stated columns.
  foreach t in array array['public.admin_role_defaults', 'public.team_notes'] loop
    foreach p in array array['public', 'anon'] loop
      if has_any_column_privilege(p::name, t, 'select, insert, update, references') then
        raise exception '0060: % holds a column privilege on %', p, t;
      end if;
    end loop;
    foreach p in array array['authenticated', 'service_role'] loop
      if has_any_column_privilege(p::name, t, 'references') then
        raise exception '0060: % holds REFERENCES on a column of %', p, t;
      end if;
    end loop;
  end loop;
  if has_any_column_privilege('authenticated', 'public.team_notes', 'insert, update') then
    raise exception '0060: a staff token may write a column of team_notes (writes go through save_team_notes)';
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname), '{}') into v_cols
    from pg_attribute a
   where a.attrelid = 'public.admin_role_defaults'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.admin_role_defaults', a.attname::text, 'insert');
  if v_cols is distinct from v_rd_insert then
    raise exception '0060: authenticated inserts admin_role_defaults columns % (expected exactly %)', v_cols, v_rd_insert;
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname), '{}') into v_cols
    from pg_attribute a
   where a.attrelid = 'public.admin_role_defaults'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.admin_role_defaults', a.attname::text, 'update');
  if v_cols is distinct from v_rd_update then
    raise exception '0060: authenticated updates admin_role_defaults columns % (expected exactly %)', v_cols, v_rd_update;
  end if;

  -- ---- The preset's trigger is its one BEFORE trigger, on insert and update, enabled.
  if (select coalesce(array_agg(t2.tgname::text order by t2.tgname collate "C"), '{}')
        from pg_trigger t2
       where t2.tgrelid = 'public.admin_role_defaults'::regclass and not t2.tgisinternal)
     <> array['admin_role_defaults_guard']
     or not exists (select 1 from pg_trigger t2
                     where t2.tgrelid = 'public.admin_role_defaults'::regclass
                       and t2.tgname = 'admin_role_defaults_guard' and t2.tgenabled::text = 'O'
                       and t2.tgfoid = 'app.tg_admin_role_defaults()'::regprocedure
                       and pg_get_triggerdef(t2.oid) ~
                           '^CREATE TRIGGER admin_role_defaults_guard BEFORE INSERT OR UPDATE ON (public\.)?admin_role_defaults FOR EACH ROW EXECUTE FUNCTION (app\.)?tg_admin_role_defaults\(\)$') then
    raise exception '0060: admin_role_defaults must have exactly one trigger, admin_role_defaults_guard, BEFORE INSERT OR UPDATE';
  end if;
  if exists (select 1 from pg_trigger t2
              where t2.tgrelid = 'public.team_notes'::regclass and not t2.tgisinternal) then
    raise exception '0060: team_notes carries a trigger (the definer owns its version)';
  end if;

  -- ---- The CHECKs: a preset's quick actions are library ids only; a note is at most 2,000
  -- characters and passes the rule.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.admin_role_defaults'::regclass
                    and conname = 'admin_role_defaults_quick_actions_shape'
                    and pg_get_constraintdef(oid) ~ 'quick_library_only\(quick_actions\)')
     or not exists (select 1 from pg_constraint
                     where conrelid = 'public.team_notes'::regclass
                       and conname = 'team_notes_body_rule'
                       and pg_get_constraintdef(oid) ~ 'char_length\(body\) <= 2000'
                       and pg_get_constraintdef(oid) ~ 'team_note_ok\(body\)') then
    raise exception '0060: the preset and note CHECKs are not as stated';
  end if;
  if not (app.quick_library_only('[]') and app.quick_library_only('[{"id": "add-service"}]')
          and not app.quick_library_only('[{"id": "x", "href": "https://a.example"}]')
          and not app.quick_library_only('[{"id": "c-abcdefgh", "label": "x"}]')
          and not app.quick_library_only('[{"id": "Bad"}]')
          and not app.quick_library_only('[{"id": "add-service"}, {"id": "add-service"}]')
          and not app.quick_library_only('["add-service"]')
          and not app.quick_library_only('{}')
          and not app.quick_library_only(
            (select jsonb_agg(jsonb_build_object('id', 'a' || g)) from generate_series(10, 22) g))) then
    raise exception '0060: app.quick_library_only does not hold presets to library ids';
  end if;
  if not (app.team_note_ok('') and app.team_note_ok(E'Shoot moved to the 14th.\nSwap the samples.\tSoon.')
          and app.team_note_ok('Budget 1,500,000 SAR, call on 14/10')
          and app.team_note_ok('٠٥٥١٢٣٤')
          and not app.team_note_ok('mail sam@example.com today')
          and not app.team_note_ok('+966 55 123 4567')
          and not app.team_note_ok('٠٥٥١٢٣٤٥٦٧')
          and not app.team_note_ok('۰۵۵۱۲۳۴۵۶۷')
          and not app.team_note_ok('055-123-4567')
          and not app.team_note_ok('(055) 123.4567')
          and not app.team_note_ok(E'abc\u202Edef')
          and not app.team_note_ok(E'a\u200Bb')
          and not app.team_note_ok(E'a\rb')
          and not app.team_note_ok(null)) then
    raise exception '0060: app.team_note_ok does not apply the team-note rule';
  end if;

  -- ---- The functions: the door is a definer staff tokens alone may call; the retention and
  -- the trigger no API role may call; the rules run as the writer, so the writers named may.
  if has_function_privilege('anon', 'public.save_team_notes(uuid, text, integer)', 'execute')
     or has_function_privilege('public', 'public.save_team_notes(uuid, text, integer)', 'execute')
     or has_function_privilege('service_role', 'public.save_team_notes(uuid, text, integer)', 'execute')
     or not has_function_privilege('authenticated', 'public.save_team_notes(uuid, text, integer)', 'execute') then
    raise exception '0060: public.save_team_notes must be executable by authenticated only';
  end if;
  foreach p in array array['app.expire_team_notes()', 'app.tg_admin_role_defaults()'] loop
    foreach t in array array['public', 'anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(t, p, 'execute') then
        raise exception '0060: % may execute %', t, p;
      end if;
    end loop;
  end loop;
  foreach p in array array['app.team_note_problem(text)', 'app.team_note_ok(text)'] loop
    if not has_function_privilege('service_role', p, 'execute')
       or has_function_privilege('authenticated', p, 'execute')
       or has_function_privilege('anon', p, 'execute')
       or has_function_privilege('public', p, 'execute') then
      raise exception '0060: % must be executable by service_role only (the CHECK runs as the writer)', p;
    end if;
  end loop;
  if not has_function_privilege('authenticated', 'app.quick_library_only(jsonb)', 'execute')
     or not has_function_privilege('service_role', 'app.quick_library_only(jsonb)', 'execute')
     or has_function_privilege('anon', 'app.quick_library_only(jsonb)', 'execute')
     or has_function_privilege('public', 'app.quick_library_only(jsonb)', 'execute') then
    raise exception '0060: app.quick_library_only must be executable by authenticated and service_role only';
  end if;
  foreach p in array array['public.save_team_notes(uuid, text, integer)', 'app.expire_team_notes()'] loop
    if not exists (select 1 from pg_proc
                    where oid = p::regprocedure and prosecdef
                      and exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c
                                   where c in ('search_path=""', 'search_path='))) then
      raise exception '0060: % must be SECURITY DEFINER with an empty search_path', p;
    end if;
  end loop;
  foreach p in array array['app.quick_library_only(jsonb)', 'app.team_note_problem(text)',
                           'app.team_note_ok(text)', 'app.tg_admin_role_defaults()'] loop
    if not exists (select 1 from pg_proc
                    where oid = p::regprocedure and not prosecdef
                      and exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c
                                   where c in ('search_path=""', 'search_path='))) then
      raise exception '0060: % must be SECURITY INVOKER with an empty search_path', p;
    end if;
  end loop;
  -- The door never writes the note's text into the log: its audit detail is the length.
  if (select prosrc from pg_proc where oid = 'public.save_team_notes(uuid, text, integer)'::regprocedure)
       !~ $re$jsonb_build_object\('length', pg_catalog\.char_length\(v_body\)\)$re$ then
    raise exception '0060: save_team_notes must audit the length only';
  end if;

  -- ---- The retention job, where pg_cron is installed. Nested: PL/pgSQL plans a condition
  -- when it first runs it, so cron.job is never named on a server without the extension.
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job
                    where jobname = 'team-notes-retention' and schedule = '25 3 * * *'
                      and command ~ 'app\.expire_team_notes\(\)') then
      raise exception '0060: the team-notes-retention job is not scheduled as stated';
    end if;
  end if;

  -- ---- The guides: the set parses and holds 13, the new guide is for everyone on /admin,
  -- finding-your-way no longer names /admin, no API role reads the set, and every tenant
  -- holds both guides as the set states them.
  v_set := app.help_article_set();
  if jsonb_typeof(v_set) <> 'array' or jsonb_array_length(v_set) <> 15 then
    raise exception '0060: app.help_article_set() must hold 15 guides';
  end if;
  if not exists (select 1 from jsonb_array_elements(v_set) a
                  where a ->> 'slug' = 'your-dashboard'
                    and a -> 'screens' = '["/admin"]'::jsonb and a -> 'caps' = '[]'::jsonb)
     or not exists (select 1 from jsonb_array_elements(v_set) a
                     where a ->> 'slug' = 'finding-your-way'
                       and a -> 'screens' = '["/admin/search", "/admin/help"]'::jsonb) then
    raise exception '0060: app.help_article_set() does not hold your-dashboard and the narrowed finding-your-way';
  end if;
  foreach p in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(p, 'app.help_article_set()', 'execute') then
      raise exception '0060: % may execute app.help_article_set()', p;
    end if;
  end loop;
  if exists (select 1 from public.tenants tn
              cross join (values ('your-dashboard'), ('finding-your-way')) as g(slug)
              where not exists (
                select 1 from public.help_articles h
                  join jsonb_to_recordset(v_set) as a (slug text, screens text[], body jsonb)
                    on a.slug = h.slug
                 where h.tenant_id = tn.id and h.slug = g.slug
                   and h.body = a.body and h.screens = a.screens)) then
    raise exception '0060: a tenant does not hold the your-dashboard and finding-your-way guides as the set states them';
  end if;
end $$;
