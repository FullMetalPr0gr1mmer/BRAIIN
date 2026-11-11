-- ─────────────────────────────────────────────────────────────────────────────
-- C9b — custom contact fields and the contact half of CRM settings (Admin v2 C9b).
-- Forward-only, EXPAND only. HELD: merges after O-11 and the contacts chain (C5 to C8).
-- Depends on 0035 (crm_settings), 0091 (crm.settings: app.role_crm_settings, the write policies
-- and the live check), 0113 (the stamp triggers without the time zone), 0131 (crm_contacts and
-- its `custom` column, app.tg_crm_contact_row, app.tg_crm_contact_events).
-- The number is a placeholder: scripts/renumber-migration.mjs moves it at merge.
--
-- What it adds (docs/admin-v2/crm.md §4.7, §5.1, "CRM-9"; as-built C9B.md):
--
--   • crm_settings.custom_fields: up to 12 field definitions {key, label, type}, type text,
--     number or date, each key once (a CHECK through app.crm_custom_fields_ok). It joins the
--     staff UPDATE column grant, so a live crm.settings holder of the tenant writes it (0091's
--     policy and RESTRICTIVE live check decide who; nothing new there). The three stamp
--     triggers fire on it too, so a definitions save moves the row's version like the other
--     cards' saves.
--   • A field that stays keeps its type (a trigger), so every stored value fits its field. A
--     key is never renamed: changing a key is removing a field and adding another.
--   • Removing a field deletes what every contact of the tenant holds in it, in the same
--     statement (a definer trigger): no value is kept that no screen shows and no person can
--     correct (data minimisation, register L-5).
--   • crm_contacts.custom is checked against the definitions in the database as well as the
--     Worker (a definer trigger): each key whose value is new or changed must be a field of the
--     contact's tenant and fit its type, so a direct write through the staff column grant (or a
--     later door) cannot store what the screen would refuse.
--   • The crm-settings help guide at its next revision (H11's put), with the new cards.
-- ─────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing (as 0091 does): this takes ACCESS
-- EXCLUSIVE on crm_settings (a new column) and SHARE ROW EXCLUSIVE on crm_contacts (a new
-- trigger). Transaction-local.
set local lock_timeout = '5s';

-- ---- 1. What a set of definitions may hold ---------------------------------------------------
-- Used in a CHECK, so every writer of crm_settings needs EXECUTE (as app.crm_pool_ok, 0091).
-- An array of at most 12 objects, each exactly {key, label, type}: a snake_case key of at most
-- 40 characters starting with a letter, a label of 1 to 60 characters with no control character
-- and no space at either end, a type of text, number or date; every key once.
create or replace function app.crm_custom_fields_ok(p jsonb) returns boolean
  language sql immutable set search_path = '' as $$
  -- CASE, not AND: the array functions below raise on an object, and AND may run them first.
  select case when p is null or jsonb_typeof(p) <> 'array' then false else
         jsonb_array_length(p) <= 12
     and not exists (
       select 1 from jsonb_array_elements(p) e
        where jsonb_typeof(e) <> 'object'
           or (select array_agg(k order by k) from jsonb_object_keys(e) k)
              is distinct from array['key', 'label', 'type']
           or jsonb_typeof(e -> 'key') <> 'string'
           or jsonb_typeof(e -> 'label') <> 'string'
           or jsonb_typeof(e -> 'type') <> 'string'
           or (e ->> 'key') !~ '^[a-z][a-z0-9_]{0,39}$'
           or char_length(e ->> 'label') not between 1 and 60
           or (e ->> 'label') <> btrim(e ->> 'label')
           or (e ->> 'label') ~ '[[:cntrl:]]'
           or (e ->> 'type') not in ('text', 'number', 'date'))
     and (select count(distinct e ->> 'key') from jsonb_array_elements(p) e) = jsonb_array_length(p)
  end
$$;
revoke all on function app.crm_custom_fields_ok(jsonb) from public, anon, authenticated, service_role;
grant execute on function app.crm_custom_fields_ok(jsonb) to authenticated, service_role;

alter table public.crm_settings
  add column if not exists custom_fields jsonb not null default '[]'::jsonb;
alter table public.crm_settings drop constraint if exists crm_settings_custom_fields_ok;
alter table public.crm_settings add constraint crm_settings_custom_fields_ok
  check (app.crm_custom_fields_ok(custom_fields));

-- ---- 2. The stamps follow the definitions too ------------------------------------------------
-- 0113's three triggers, the same names (so the same order among the BEFORE triggers) and the
-- same functions, with custom_fields added to their column lists.
drop trigger crm_settings_updated_at on public.crm_settings;
create trigger crm_settings_updated_at
  before update of scoring, sla_hours, assignment_rule, assignment_pool, assignment_fixed_to,
                   custom_fields
  on public.crm_settings
  for each row execute function app.tg_set_updated_at();
drop trigger crm_settings_actor on public.crm_settings;
create trigger crm_settings_actor
  before insert or update of scoring, sla_hours, assignment_rule, assignment_pool,
                             assignment_fixed_to, custom_fields
  on public.crm_settings
  for each row execute function app.tg_set_actor();
drop trigger crm_settings_version on public.crm_settings;
create trigger crm_settings_version
  before update of scoring, sla_hours, assignment_rule, assignment_pool, assignment_fixed_to,
                   custom_fields
  on public.crm_settings
  for each row execute function app.tg_bump_version();

-- ---- 3. A field keeps its type ---------------------------------------------------------------
-- Changing a kept field's type would leave contacts holding values of the old type. Remove the
-- field (its values go with it) and add a new one instead. The message names a constraint so
-- the Worker can say which field is wrong.
create or replace function app.tg_crm_settings_custom_fields() returns trigger
  language plpgsql set search_path = '' as $$
begin
  -- A set that is not an array is the CHECK's to refuse (23514); the lookups below would raise
  -- 22023 on it first.
  if jsonb_typeof(new.custom_fields) <> 'array' or jsonb_typeof(old.custom_fields) <> 'array' then
    return new;
  end if;
  if exists (select 1
               from jsonb_array_elements(new.custom_fields) n
               join jsonb_array_elements(old.custom_fields) o on o ->> 'key' = n ->> 'key'
              where o ->> 'type' is distinct from n ->> 'type') then
    raise exception using errcode = '23514',
      message = 'a custom field keeps its type (constraint "crm_settings_custom_field_type")';
  end if;
  return new;
end $$;
revoke all on function app.tg_crm_settings_custom_fields() from public, anon, authenticated, service_role;
drop trigger if exists crm_settings_custom_fields on public.crm_settings;
create trigger crm_settings_custom_fields
  before update of custom_fields on public.crm_settings
  for each row execute function app.tg_crm_settings_custom_fields();

-- ---- 4. A removed field takes its values with it ---------------------------------------------
-- In the statement that removes it, for every contact of the tenant (merge tombstones too). A
-- definer: a staff token may not see every contact, and every value must go. The contacts' own
-- row trigger (0131) counts it as an edit by the person who removed the field (the version, the
-- `details_changed` line naming `custom`) and never as a person editing that contact
-- (staff_edited is a direct write's only, and this write is a trigger's).
create or replace function app.tg_crm_settings_custom_removed() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_removed text[];
begin
  select coalesce(array_agg(o ->> 'key'), '{}') into v_removed
    from jsonb_array_elements(old.custom_fields) o
   where not exists (select 1 from jsonb_array_elements(new.custom_fields) n
                      where n ->> 'key' = o ->> 'key');
  if cardinality(v_removed) > 0 then
    update public.crm_contacts c
       set custom = c.custom - v_removed
     where c.tenant_id = new.tenant_id
       and c.custom ?| v_removed;
  end if;
  return null;
end $$;
revoke all on function app.tg_crm_settings_custom_removed() from public, anon, authenticated, service_role;
drop trigger if exists crm_settings_custom_removed on public.crm_settings;
create trigger crm_settings_custom_removed
  after update of custom_fields on public.crm_settings
  for each row execute function app.tg_crm_settings_custom_removed();

-- ---- 5. A contact's values fit their fields ---------------------------------------------------
-- A real calendar date written YYYY-MM-DD (the date input's own form). Stable, not immutable:
-- a cast to date reads the session's settings (an ISO date parses the same under all of them).
create or replace function app.crm_custom_date_ok(p text) returns boolean
  language plpgsql stable set search_path = '' as $$
begin
  if p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return false;
  end if;
  return to_char(p::date, 'YYYY-MM-DD') = p;
exception when others then
  return false;
end $$;
revoke all on function app.crm_custom_date_ok(text) from public, anon, authenticated, service_role;

-- Each key whose value is new or changed must be a field of the contact's tenant, and the value
-- must fit its type: text a string of at most 500 characters with no control character, number
-- a JSON number of at most 10^15 either way, date a real YYYY-MM-DD date. JSON null is allowed
-- (an empty field). Values left as they were are not checked again (a removed field's values
-- are already gone, section 4). A definer: it reads the tenant's definitions whoever writes.
-- No staff token inserts a contact, and an UPDATE reaches only rows RLS lets it see, so the
-- refusal tells nobody anything about another tenant.
create or replace function app.tg_crm_contact_custom() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_defs jsonb;
  v_type text;
  r record;
begin
  if tg_op = 'UPDATE' and new.custom is not distinct from old.custom then
    return new;
  end if;
  select coalesce(s.custom_fields, '[]'::jsonb) into v_defs
    from public.crm_settings s where s.tenant_id = new.tenant_id;
  for r in
    select n.key, n.value
      from jsonb_each(coalesce(new.custom, '{}'::jsonb)) n
     where tg_op = 'INSERT' or (old.custom -> n.key) is distinct from n.value
  loop
    select e ->> 'type' into v_type
      from jsonb_array_elements(coalesce(v_defs, '[]'::jsonb)) e
     where e ->> 'key' = r.key;
    if v_type is null
       or (jsonb_typeof(r.value) <> 'null'
           and not case v_type
             when 'text' then jsonb_typeof(r.value) = 'string'
                              and char_length(r.value #>> '{}') <= 500
                              and (r.value #>> '{}') !~ '[[:cntrl:]]'
             when 'number' then jsonb_typeof(r.value) = 'number'
                                and abs((r.value #>> '{}')::numeric) <= 1e15
             when 'date' then jsonb_typeof(r.value) = 'string'
                              and app.crm_custom_date_ok(r.value #>> '{}')
             else false
           end) then
      raise exception using errcode = '23514',
        message = 'a custom value must be a defined field of this tenant and fit its type (constraint "crm_contacts_custom_fields")';
    end if;
  end loop;
  return new;
end $$;
revoke all on function app.tg_crm_contact_custom() from public, anon, authenticated, service_role;
drop trigger if exists crm_contacts_custom_fields on public.crm_contacts;
create trigger crm_contacts_custom_fields
  before insert or update of custom on public.crm_contacts
  for each row execute function app.tg_crm_contact_custom();

-- ---- 6. Who writes the definitions --------------------------------------------------------------
-- The column joins 0091's grant: the policies crm_settings_write and the RESTRICTIVE
-- crm_settings_write_live already let only a live crm.settings holder of the tenant update.
revoke all on public.crm_settings from public, anon, authenticated, service_role;
grant select on public.crm_settings to authenticated;
grant update (scoring, sla_hours, assignment_rule, assignment_pool, assignment_fixed_to,
              custom_fields)
  on public.crm_settings to authenticated;
grant select, insert, update on public.crm_settings to service_role;

-- ---- 7. The help guide --------------------------------------------------------------------------
-- crm-settings at its next revision (0091 put it at 0, so the catalog holds revision 1). H11's
-- put: one top-level statement at the start of a line, outside any DO block.
select app.put_help_guide($guide$
{
  "slug": "crm-settings",
  "sort_order": 75,
  "minutes": 4,
  "tags": ["leads", "contacts", "settings"],
  "screens": ["/admin/crm/settings"],
  "caps": ["crm.settings"],
  "title": "CRM settings",
  "title_ar": "إعدادات إدارة العملاء",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "CRM settings decide how the leads pipeline looks, what happens to a new lead and which extra fields every contact has. Only an Admin opens this page. Each card has its own Save, and nothing changes until you press it."
      },
      { "t": "h", "x": "Pipeline stages" },
      {
        "t": "ol",
        "x": [
          "The stages are the columns of the Leads pipeline, in this order. Rename a stage, choose its colour by name, and say what it counts as: Open, Won or Lost.",
          "A pipeline has 2 to 10 stages, with at least one Won and one Lost stage. The first stage is where every new lead starts, so it stays first and stays open.",
          "Add stage puts a new stage at the end. Move up and Move down change the order. Save stages keeps the whole pipeline at once.",
          "Each stage shows how many leads it holds. A stage that holds leads cannot be removed and keeps what it counts as: move its leads to another stage first.",
          "If someone else saved the stages while you were editing, your save stops and asks you to reload, so nobody's change is lost."
        ]
      },
      { "t": "h", "x": "Lead scoring" },
      {
        "t": "ol",
        "x": [
          "A lead scores points for what its inquiry tells you: a budget, a company e-mail, a service it asked about and more. Each sign is worth 0 to 50 points, and a score never goes above 100.",
          "Save scoring re-scores every lead at once, so the list never mixes old and new points. Scores of 75 and above show green."
        ]
      },
      { "t": "h", "x": "Response time and assignment" },
      {
        "t": "ol",
        "x": [
          "Answer new leads within sets how many hours a new web lead may wait. After that, the leads list marks it Over response time.",
          "New leads go to: Manual leaves them for someone to pick up. Round robin gives each new lead to the next person in the rotation, and skips anyone switched off. Always to one person gives every new lead to them.",
          "Only active team members who work leads can be chosen."
        ]
      },
      { "t": "h", "x": "Contact stages" },
      {
        "t": "p",
        "x": "Every contact is a Lead, a Client, a Past client or a Partner. The four stages are fixed; the card says what each one means. You change a contact's stage on their page."
      },
      { "t": "h", "x": "Custom fields" },
      {
        "t": "ol",
        "x": [
          "Custom fields show on every contact under Details, and in Add contact. You can have up to 12. Each has a label, a type (Text, Number or Date) and a key, the short name it is saved under.",
          "Add field adds one, and Save fields keeps them all. A field's key and type are fixed once it is saved; its label can change at any time.",
          "Removing a field deletes what every contact holds in it, and cannot be undone. The page asks you to confirm before it saves."
        ]
      },
      { "t": "h", "x": "Data and privacy" },
      {
        "t": "ol",
        "x": [
          "The card says how long leads and contacts are kept after their last activity. Change it in General settings.",
          "Erase a person's data finds a contact by name or company and erases everything about them: their leads, notes, tasks, e-mails and phone numbers. It asks why, then asks again before it erases, and the erasure is recorded in the activity log.",
          "A person can ask what you hold about them, or ask for it to be erased. Answer within 30 days."
        ]
      },
      {
        "t": "tip",
        "x": "Every save here is recorded in the activity log, card by card."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "تحدد إعدادات إدارة العملاء شكل مراحل العملاء المحتملين، وما يحدث لكل عميل محتمل جديد، والحقول الإضافية التي تظهر لكل جهة اتصال. لا يفتح هذه الصفحة إلا المسؤول (Admin). لكل بطاقة زر حفظ خاص بها، ولا يتغير شيء حتى تضغطه."
      },
      { "t": "h", "x": "مراحل العملاء (Pipeline stages)" },
      {
        "t": "ol",
        "x": [
          "المراحل هي أعمدة لوحة Pipeline في صفحة Leads، بهذا الترتيب. يمكنك تغيير اسم المرحلة، واختيار لونها باسمه، وتحديد ما تُحسب عليه: Open أو Won أو Lost.",
          "تضم لوحة المراحل من 2 إلى 10 مراحل، منها مرحلة Won واحدة على الأقل ومرحلة Lost واحدة على الأقل. والمرحلة الأولى هي التي يبدأ منها كل عميل محتمل جديد، لذلك تبقى أولًا وتبقى مفتوحة.",
          "يضيف زر Add stage مرحلة جديدة في آخر القائمة، ويغيّر الزران Move up وMove down الترتيب. ويحفظ زر Save stages المراحل كلها دفعة واحدة.",
          "تُظهر كل مرحلة عدد العملاء المحتملين فيها. والمرحلة التي فيها عملاء محتملون لا يمكن حذفها ولا تغيير ما تُحسب عليه: انقل عملاءها إلى مرحلة أخرى أولًا.",
          "إذا حفظ شخص آخر المراحل وأنت تعدّلها، يتوقف حفظك ويطلب منك إعادة تحميل الصفحة، حتى لا يضيع تعديل أحد."
        ]
      },
      { "t": "h", "x": "تقييم العملاء (Lead scoring)" },
      {
        "t": "ol",
        "x": [
          "يحصل كل عميل محتمل على نقاط بحسب ما يذكره في استفساره: ميزانية، أو بريد إلكتروني لشركة، أو خدمة سأل عنها، وغير ذلك. قيمة كل علامة من 0 إلى 50 نقطة، ولا يتجاوز التقييم 100.",
          "يعيد زر Save scoring حساب تقييم كل العملاء المحتملين في الحال، فلا تختلط في القائمة نقاط قديمة بنقاط جديدة. ويظهر التقييم من 75 فما فوق باللون الأخضر."
        ]
      },
      { "t": "h", "x": "وقت الرد والتوزيع (Response time and assignment)" },
      {
        "t": "ol",
        "x": [
          "يحدد حقل Answer new leads within عدد الساعات التي يمكن أن ينتظرها عميل محتمل جديد من الموقع. وبعدها تضع عليه قائمة العملاء المحتملين علامة Over response time.",
          "يحدد New leads go to لمن يذهب العميل المحتمل الجديد: يتركه Manual لمن يتولاه من الفريق. ويعطي Round robin كل عميل محتمل جديد للشخص التالي في الدور، ويتخطى من أُوقف حسابه. ويعطي Always to one person كل عميل محتمل جديد لشخص واحد.",
          "لا يمكن اختيار إلا أعضاء الفريق النشطين الذين يعملون على العملاء المحتملين."
        ]
      },
      { "t": "h", "x": "مراحل جهات الاتصال (Contact stages)" },
      {
        "t": "p",
        "x": "كل جهة اتصال إما Lead أو Client أو Past client أو Partner. هذه المراحل الأربع ثابتة، وتشرح البطاقة معنى كل واحدة منها. وتغيّر مرحلة جهة الاتصال من صفحتها."
      },
      { "t": "h", "x": "الحقول المخصصة (Custom fields)" },
      {
        "t": "ol",
        "x": [
          "تظهر الحقول المخصصة لكل جهة اتصال تحت Details، وفي Add contact. يمكنك إضافة 12 حقلًا على الأكثر. لكل حقل اسم ظاهر، ونوع (Text أو Number أو Date)، ومفتاح، وهو الاسم القصير الذي يُحفظ به.",
          "يضيف زر Add field حقلًا، ويحفظ زر Save fields الحقول كلها. ويثبت مفتاح الحقل ونوعه بعد حفظه، أما اسمه الظاهر فيمكن تغييره في أي وقت.",
          "حذف حقل يحذف ما تحمله كل جهات الاتصال فيه، ولا يمكن التراجع عنه. وتطلب منك الصفحة التأكيد قبل الحفظ."
        ]
      },
      { "t": "h", "x": "البيانات والخصوصية (Data and privacy)" },
      {
        "t": "ol",
        "x": [
          "تذكر البطاقة مدة الاحتفاظ بالعملاء المحتملين وجهات الاتصال بعد آخر نشاط لهم. وتغيّرها من General settings.",
          "يبحث زر Erase a person's data عن جهة اتصال بالاسم أو الشركة، ثم يمحو كل ما يخصها: العملاء المحتملين المرتبطين بها، والملاحظات، والمهام، وعناوين البريد الإلكتروني، وأرقام الهاتف. ويسألك عن السبب، ثم يطلب التأكيد مرة ثانية قبل المحو، ويُسجَّل المحو في سجل النشاط.",
          "يحق للشخص أن يسأل عما تحتفظ به عنه، أو أن يطلب محوه. أجب خلال 30 يومًا."
        ]
      },
      {
        "t": "tip",
        "x": "يُسجَّل كل حفظ في هذه الصفحة في سجل النشاط، بطاقةً بطاقة."
      }
    ]
  }
}
$guide$::jsonb, 1);

-- ---- 8. Postconditions (Admin v2 P-14: both grant regimes) ------------------------------------
do $$
declare
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger']
    || case when current_setting('server_version_num')::int >= 170000
            then array['maintain'] else array[]::text[] end;
  v_col_privs constant text[] := array['select', 'insert', 'update', 'references'];
  v_cfg constant text :=
    'scoring, sla_hours, assignment_rule, assignment_pool, assignment_fixed_to, custom_fields';
  v_who text;
  p text;
  v_fn text;
  v_have text[];
begin
  -- RLS stays on and forced on both tables this touches.
  if (select count(*) from pg_class
       where oid in ('public.crm_settings'::regclass, 'public.crm_contacts'::regclass)
         and relrowsecurity and relforcerowsecurity) <> 2 then
    raise exception 'C9b: crm_settings and crm_contacts must be ENABLE + FORCE row level security';
  end if;

  -- The column, its default and its CHECK; every tenant's definitions valid (none yet).
  if not exists (select 1 from pg_attribute a
                  where a.attrelid = 'public.crm_settings'::regclass and a.attname = 'custom_fields'
                    and a.atttypid = 'jsonb'::regtype and a.attnotnull and not a.attisdropped)
     or not exists (select 1 from pg_constraint
                     where conrelid = 'public.crm_settings'::regclass
                       and conname = 'crm_settings_custom_fields_ok' and contype = 'c'
                       and convalidated) then
    raise exception 'C9b: crm_settings.custom_fields or its CHECK is missing';
  end if;
  if exists (select 1 from public.tenants t
              where not exists (select 1 from public.crm_settings c
                                 where c.tenant_id = t.id and c.custom_fields = '[]'::jsonb)) then
    raise exception 'C9b: a tenant has no crm_settings row with empty definitions';
  end if;
  -- C6 refused every custom value until now, so no contact holds one.
  if exists (select 1 from public.crm_contacts where custom <> '{}'::jsonb) then
    raise exception 'C9b: a contact holds a custom value before any field was defined';
  end if;

  -- The stamps fire on the configuration columns, exactly.
  if (select count(*) from pg_trigger t
       where t.tgrelid = 'public.crm_settings'::regclass and not t.tgisinternal
         and t.tgenabled = 'O'
         and (t.tgname, pg_get_triggerdef(t.oid)) in (
           ('crm_settings_updated_at',
            'CREATE TRIGGER crm_settings_updated_at BEFORE UPDATE OF ' || v_cfg
            || ' ON public.crm_settings FOR EACH ROW EXECUTE FUNCTION app.tg_set_updated_at()'),
           ('crm_settings_actor',
            'CREATE TRIGGER crm_settings_actor BEFORE INSERT OR UPDATE OF ' || v_cfg
            || ' ON public.crm_settings FOR EACH ROW EXECUTE FUNCTION app.tg_set_actor()'),
           ('crm_settings_version',
            'CREATE TRIGGER crm_settings_version BEFORE UPDATE OF ' || v_cfg
            || ' ON public.crm_settings FOR EACH ROW EXECUTE FUNCTION app.tg_bump_version()'))) <> 3 then
    raise exception 'C9b: crm_settings'' stamp triggers do not fire on exactly the configuration columns';
  end if;
  -- The three new triggers, switched on.
  if (select count(*) from pg_trigger t
       where not t.tgisinternal and t.tgenabled = 'O'
         and (t.tgrelid, t.tgname, t.tgfoid) in (
           ('public.crm_settings'::regclass, 'crm_settings_custom_fields',
            'app.tg_crm_settings_custom_fields()'::regprocedure),
           ('public.crm_settings'::regclass, 'crm_settings_custom_removed',
            'app.tg_crm_settings_custom_removed()'::regprocedure),
           ('public.crm_contacts'::regclass, 'crm_contacts_custom_fields',
            'app.tg_crm_contact_custom()'::regprocedure))) <> 3 then
    raise exception 'C9b: a custom-field trigger is missing or switched off';
  end if;

  -- PUBLIC and anon hold nothing on crm_settings, table-wide or on a column.
  foreach v_who in array array['public', 'anon'] loop
    foreach p in array v_privs loop
      if has_table_privilege(v_who, 'public.crm_settings', p) then
        raise exception 'C9b: % holds % on crm_settings', v_who, p;
      end if;
    end loop;
    foreach p in array v_col_privs loop
      if has_any_column_privilege(v_who, 'public.crm_settings', p) then
        raise exception 'C9b: % holds % on a column of crm_settings', v_who, p;
      end if;
    end loop;
  end loop;
  -- authenticated: SELECT, plus UPDATE of the six configuration columns.
  foreach p in array v_privs loop
    if (p = 'select') <> has_table_privilege('authenticated', 'public.crm_settings', p) then
      raise exception 'C9b: authenticated table-wide % on crm_settings is wrong', p;
    end if;
    if (p in ('select', 'insert', 'update')) <> has_table_privilege('service_role', 'public.crm_settings', p) then
      raise exception 'C9b: service_role table-wide % on crm_settings is wrong', p;
    end if;
  end loop;
  select coalesce(array_agg(a.attname::text order by a.attname::text collate "C"), '{}') into v_have
    from pg_attribute a
   where a.attrelid = 'public.crm_settings'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.crm_settings', a.attname::text, 'update');
  if v_have is distinct from array['assignment_fixed_to', 'assignment_pool', 'assignment_rule',
                                   'custom_fields', 'scoring', 'sla_hours'] then
    raise exception 'C9b: authenticated may update crm_settings columns %', v_have;
  end if;
  if has_any_column_privilege('authenticated', 'public.crm_settings', 'insert')
     or has_any_column_privilege('authenticated', 'public.crm_settings', 'references') then
    raise exception 'C9b: authenticated inserts or references crm_settings columns';
  end if;
  -- The policies that decide who updates are 0091's, unchanged: the tenant first, live.
  if (select array_agg(policyname::text || ':' || permissive || ':' || cmd order by policyname)
        from pg_policies where schemaname = 'public' and tablename = 'crm_settings')
     is distinct from array['crm_settings_read:PERMISSIVE:SELECT', 'crm_settings_write:PERMISSIVE:UPDATE',
                            'crm_settings_write_live:RESTRICTIVE:UPDATE'] then
    raise exception 'C9b: crm_settings has an unexpected policy set';
  end if;

  -- The functions: pinned, run by no API role but the CHECK's helper.
  foreach v_fn in array array['app.crm_custom_fields_ok(jsonb)', 'app.crm_custom_date_ok(text)',
                              'app.tg_crm_settings_custom_fields()',
                              'app.tg_crm_settings_custom_removed()',
                              'app.tg_crm_contact_custom()'] loop
    if not exists (select 1 from pg_proc
                    where oid = v_fn::regprocedure
                      and proconfig @> array['search_path=""']) then
      raise exception 'C9b: % does not pin an empty search_path', v_fn;
    end if;
  end loop;
  if not has_function_privilege('authenticated', 'app.crm_custom_fields_ok(jsonb)', 'execute')
     or not has_function_privilege('service_role', 'app.crm_custom_fields_ok(jsonb)', 'execute')
     or has_function_privilege('anon', 'app.crm_custom_fields_ok(jsonb)', 'execute') then
    raise exception 'C9b: the definitions CHECK helper is not executable by exactly its writers';
  end if;
  foreach v_fn in array array['app.crm_custom_date_ok(text)', 'app.tg_crm_settings_custom_fields()',
                              'app.tg_crm_settings_custom_removed()',
                              'app.tg_crm_contact_custom()'] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or has_function_privilege('service_role', v_fn, 'execute') then
      raise exception 'C9b: % is executable by an API role', v_fn;
    end if;
  end loop;
  -- The two definers read or write FORCE RLS tables for every row: their owner bypasses RLS.
  foreach v_fn in array array['app.tg_crm_settings_custom_removed()', 'app.tg_crm_contact_custom()'] loop
    if not exists (select 1 from pg_proc f join pg_roles r on r.oid = f.proowner
                    where f.oid = v_fn::regprocedure and f.prosecdef
                      and (r.rolsuper or r.rolbypassrls)) then
      raise exception 'C9b: % is not a definer owned by a role that bypasses RLS', v_fn;
    end if;
  end loop;

  -- The guide is in the catalog at its next revision, and in every tenant's help centre.
  if not exists (select 1 from app.help_guide_catalog
                  where slug = 'crm-settings' and caps = '{crm.settings}' and sort_order = 75
                    and revision = 2)
     or exists (select 1 from public.tenants t
                 where not exists (select 1 from public.help_articles h
                                    where h.tenant_id = t.id and h.slug = 'crm-settings')) then
    raise exception 'C9b: the crm-settings guide is not at its next revision in the catalog and every tenant';
  end if;
end $$;
