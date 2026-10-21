import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EditorForm from '@/components/admin/fields/EditorForm';
import { openDetailsAround } from '@/components/admin/fields/reveal';
import ApplicationsSwitch, {
  LOCKED_NOTE,
} from '@/components/admin/screens/general/ApplicationsSwitch';
import BrandFacts, { LOGO_NOTE } from '@/components/admin/screens/general/BrandFacts';
import TurnOnDialog, { turnOnText } from '@/components/admin/screens/maintenance/TurnOnDialog';
import MaintenanceSketch, {
  dayWords,
} from '@/components/admin/screens/maintenance/MaintenanceSketch';
import SaveStatus, { saveStatusText } from '@/components/admin/kit/SaveStatus';
import { ClockProvider } from '@/components/admin/kit/clock';
import { buildSaveRequest, entitySaveReducer, initialSaveState } from '@/lib/admin/entitySave';
import { ValidationError } from '@/lib/admin/errors';
import { formToPayload, newItem, rowToForm } from '@/lib/admin/formPayload';
import { clockFor } from '@/lib/admin/relTime';
import { rethrowWriteError } from '@/lib/admin/singleton';
import { siteProfileSingleton } from '@/lib/admin/singletons/siteProfile';
import { siteSettingsSingleton } from '@/lib/admin/singletons/siteSettings';
import { profileUi } from '@/lib/admin/ui/profile';
import { settingsUi } from '@/lib/admin/ui/settings';
import { maintenanceUi } from '@/lib/admin/ui/maintenance';
import type { EntitySave } from '@/lib/admin/useEntitySave';
import type { FieldDef, FieldGroup } from '@/lib/admin/uiSchema';
import { MAINTENANCE_DEFAULTS, readMaintenance } from '@schemas/maintenance';
import { MAINTENANCE_KV_KEY } from '@/lib/http/maintenance';
import { __kv } from '../stubs/cloudflare-workers';

// General settings v2 and maintenance v2's admin pieces (Admin v2 U9): EditorForm's groups
// and the reveal of a closed card, the singleton kernel's named constraints, the default-on
// switch in a repeater, the adopted version, the studio's clock in the screens, and the
// screens' own words.

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

function fakeSave(values: Record<string, unknown>, patch: Partial<EntitySave> = {}): EntitySave {
  return {
    isNew: false,
    values,
    set: () => undefined,
    version: 2,
    busy: false,
    loadError: null,
    status: 'idle',
    savedAt: null,
    errors: { byId: {}, summary: [] },
    conflict: false,
    edgeMissed: false,
    dirty: false,
    message: null,
    save: async () => true,
    reloadTheirs: async () => undefined,
    adoptVersion: () => undefined,
    ...patch,
  };
}

const FIELDS: FieldDef[] = [
  { name: 'a', label: 'Alpha', kind: 'text' },
  { name: 'b', label: 'Beta', kind: 'text' },
  { name: 'c', label: 'Gamma', kind: 'text' },
  { name: 'd', label: 'Delta', kind: 'text' },
];

describe('EditorForm groups (Admin v2 U9)', () => {
  const groups: FieldGroup[] = [
    { id: 'left', title: 'Left card', column: 'left', fields: ['a'] },
    { id: 'right', title: 'Right card', sub: 'A line', column: 'right', fields: ['b'] },
    { id: 'more', title: 'Advanced', column: 'left', collapsible: true, fields: ['c'] },
  ];
  const render = (extra = {}) =>
    renderToStaticMarkup(
      createElement(EditorForm, {
        save: fakeSave({}),
        fields: FIELDS,
        submitLabel: 'Save',
        ...extra,
      }),
    );

  it('without groups: one card, as before', () => {
    const html = render();
    expect(html).not.toContain('editor__group');
    expect(html.match(/class="card"/g)).toHaveLength(1);
  });

  it('cards in two columns, a closed card as <details>, the rest after', () => {
    const html = render({ groups, slots: { left: createElement('p', { id: 'slot' }, 'Slot') } });
    expect(html).toContain('class="grid grid--2 editor__cols"');
    expect(html).toMatch(
      /<section class="card editor__group" data-group="left" aria-labelledby="g-left"><h2 class="card-title" id="g-left">Left card<\/h2><p id="slot">Slot<\/p>/,
    );
    expect(html).toContain('<p class="admin-sub editor__group-sub">A line</p>');
    expect(html).toMatch(
      /<details class="card editor__group" data-group="more"><summary class="card-title">Advanced<\/summary>/,
    );
    expect(html).not.toMatch(/<details[^>]* open/);
    // Delta is in no group: it follows, in a card of its own.
    expect(html.indexOf('id="f-d"')).toBeGreaterThan(html.indexOf('id="f-c"'));
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('every field of the General screen’s forms sits in a card', () => {
    for (const ui of [profileUi, settingsUi, maintenanceUi]) {
      const grouped = new Set(ui.groups!.flatMap((g) => g.fields));
      const drawn = ui.fields.filter((f) => f.name !== 'active').map((f) => f.name);
      expect(
        drawn.filter((n) => !grouped.has(n)),
        ui.endpoint,
      ).toEqual([]);
      for (const name of grouped)
        expect(
          ui.fields.map((f) => f.name),
          name,
        ).toContain(name);
    }
    expect(profileUi.fields.map((f) => f.name)).not.toContain('acceptingApplications');
    expect(settingsUi.fields.map((f) => f.name)).not.toContain('identity');
  });
});

describe('an error in a closed card is shown: its <details> are opened first', () => {
  it('opens every closed ancestor, innermost first', () => {
    const outer = { open: false, parentElement: null as unknown, closest: () => null };
    const inner = {
      open: false,
      parentElement: { closest: (s: string) => (s === 'details' ? outer : null) },
      closest: () => null,
    };
    const input = { parentElement: { closest: (s: string) => (s === 'details' ? inner : null) } };
    expect(openDetailsAround(input as unknown as Element)).toBe(2);
    expect(inner.open && outer.open).toBe(true);
    expect(openDetailsAround(input as unknown as Element)).toBe(0);
  });
});

describe('the singleton kernel names a refused value’s field (constraintFields)', () => {
  const refuse = (code: string, constraint: string) => {
    try {
      rethrowWriteError(
        'site_profile',
        'settings.general',
        'update',
        {
          code,
          message: `new row for relation "site_profile" violates check constraint "${constraint}"`,
        },
        siteProfileSingleton.foreignKeys,
        siteProfileSingleton.constraintFields,
      );
    } catch (err) {
      return err;
    }
    return null;
  };

  it.each([
    ['23514', 'site_profile_favicon_square', 'faviconMediaId'],
    ['23514', 'site_profile_app_icon_square', 'appIconMediaId'],
    ['23514', 'site_profile_phone_display_needs_number', 'phoneDisplay'],
    ['23514', 'site_profile_whatsapp_display_needs_number', 'whatsappDisplay'],
    ['23503', 'site_profile_favicon_fk', 'faviconMediaId'],
    ['23503', 'site_profile_app_icon_fk', 'appIconMediaId'],
  ])('%s %s → a 422 on %s', (code, constraint, field) => {
    const err = refuse(code, constraint);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).field).toBe(field);
  });

  it('an unnamed CHECK stays the generic 422; another code stays a 500', () => {
    const generic = refuse('23514', 'something_else');
    expect(generic).toBeInstanceOf(ValidationError);
    expect((generic as ValidationError).field).toBeUndefined();
    expect(refuse('XX000', 'site_profile_favicon_square')).not.toBeInstanceOf(ValidationError);
  });

  it('the settings row names its zone list', () => {
    expect(siteSettingsSingleton.constraintFields?.['site_settings_timezone_closed']?.field).toBe(
      'timezone',
    );
  });
});

describe('an identity save refreshes the 503’s buttons from the maintenance ROW (afterWrite)', () => {
  // KV is eventually consistent: this location can still hold the value from before a
  // colleague's maintenance save. The settings row is the source of truth for every setting,
  // so the follow-up builds the edge's value from it, and KV only says whether the edge has
  // maintenance on at all (an identity save never switches the site on).
  const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const identity = {
    brand_name: { en: 'New', ar: 'جديد' },
    contact_email: 'new@example.test',
    whatsapp_e164: null,
  };
  const onRow = { ...MAINTENANCE_DEFAULTS, active: true, staffBypass: false, allowlist: [] };
  const staleOn = JSON.stringify({
    ...onRow,
    staffBypass: true,
    allowlist: ['203.0.113.9'],
    copy: { title: { en: 'Old', ar: 'قديم' }, message: null },
  });
  let reads: string[] = [];
  const sb = (answer: { data: unknown; error: unknown }) =>
    ({
      from: (table: string) => ({
        select: (columns: string) => ({
          eq: (column: string, value: string) => ({
            maybeSingle: async () => {
              reads.push(`${table}.${columns} ${column}=${value}`);
              return answer;
            },
          }),
        }),
      }),
    }) as never;
  const after = (answer: { data: unknown; error: unknown }) =>
    siteProfileSingleton.afterWrite!({
      auth: { tenantId: TENANT } as never,
      sb: sb(answer),
      row: identity,
    });
  beforeEach(() => {
    __kv.clear();
    reads = [];
  });

  it('the row’s settings with the new buttons, whatever KV held (a stale bypass and IP)', async () => {
    __kv.set(MAINTENANCE_KV_KEY, staleOn);
    expect(await after({ data: { maintenance: onRow }, error: null })).toEqual({
      maintenanceContact: 'refreshed',
    });
    expect(reads).toEqual([`site_settings.maintenance tenant_id=${TENANT}`]);
    const edge = readMaintenance(__kv.get(MAINTENANCE_KV_KEY) ?? null);
    expect(edge).toEqual(
      readMaintenance({
        ...onRow,
        contact: { brand: identity.brand_name, email: identity.contact_email, whatsappE164: null },
      }),
    );
    expect(edge).toMatchObject({ staffBypass: false, allowlist: [], copy: { title: null } });
  });

  it('a colleague turned it off (the row says off, a stale KV on): nothing is put back', async () => {
    __kv.set(MAINTENANCE_KV_KEY, staleOn);
    for (const data of [{ maintenance: { ...onRow, active: false } }, null]) {
      expect(await after({ data, error: null })).toBeUndefined();
      expect(__kv.get(MAINTENANCE_KV_KEY)).toBe(staleOn);
    }
  });

  it('an unreadable row writes nothing and says so', async () => {
    __kv.set(MAINTENANCE_KV_KEY, staleOn);
    expect(await after({ data: null, error: { code: '57014' } })).toEqual({
      maintenanceContact: 'not-refreshed',
    });
    expect(__kv.get(MAINTENANCE_KV_KEY)).toBe(staleOn);
  });

  it('the edge off: no row read, nothing written; an identity save never switches it on', async () => {
    expect(await after({ data: { maintenance: onRow }, error: null })).toBeUndefined();
    __kv.set(MAINTENANCE_KV_KEY, JSON.stringify({ ...onRow, active: false }));
    expect(await after({ data: { maintenance: onRow }, error: null })).toBeUndefined();
    expect(reads).toEqual([]);
    expect(readMaintenance(__kv.get(MAINTENANCE_KV_KEY) ?? null).active).toBe(false);
  });
});

describe('a switch that is on by default in a repeater (a social account’s "Show on the site")', () => {
  const socials = profileUi.fields.find((f) => f.name === 'socials')!;

  it('a new item starts shown, and an untouched new item is still no item', () => {
    expect(newItem(socials.itemFields!)).toEqual({ visible: true });
    const payload = formToPayload({ socials: [newItem(socials.itemFields!)] }, [socials]);
    expect(payload['socials']).toEqual([]);
  });

  it('sent only when turned off; a stored item with no flag shows as on', () => {
    const shown = formToPayload(
      { socials: [{ network: 'x', handle: '@a', url: 'https://x.com/a', visible: true }] },
      [socials],
    );
    expect(shown['socials']).toEqual([{ network: 'x', handle: '@a', url: 'https://x.com/a' }]);
    const hidden = formToPayload(
      { socials: [{ network: 'x', handle: '@a', url: 'https://x.com/a', visible: false }] },
      [socials],
    );
    expect(hidden['socials']).toEqual([
      { network: 'x', handle: '@a', url: 'https://x.com/a', visible: false },
    ]);
    const form = rowToForm({ socials: [{ network: 'x', handle: '@a', url: 'https://x.com/a' }] }, [
      socials,
    ]);
    expect((form['socials'] as Record<string, unknown>[])[0]?.['visible']).toBe(true);
  });
});

describe('useEntitySave’s adopted version (the General screen’s applications switch)', () => {
  // The intake endpoint writes with no version check. The form takes the row's new version
  // only when that write is provably the ONLY change since the form's version (the row moved
  // by exactly one); otherwise a colleague's identity save sits in between, and the form's
  // next save (every field, at its version) must still be the 409 that protects it.
  const target = { kind: 'singleton', endpoint: profileUi.endpoint } as const;
  const loadedAt = (version: number) =>
    entitySaveReducer(
      entitySaveReducer(initialSaveState(profileUi.fields, false), {
        type: 'loaded',
        row: { version, contact_email: 'old@studio.test' },
        fields: profileUi.fields,
        versionFallback: 0,
      }),
      { type: 'set', name: 'contactEmail', value: 'mine@studio.test' },
    );

  it('takes the version its own write made and keeps the values on screen', () => {
    const adopted = entitySaveReducer(loadedAt(5), { type: 'version', version: 6 });
    expect(adopted.version).toBe(6);
    expect(adopted.values['contactEmail']).toBe('mine@studio.test');
    expect(adopted.status).toBe('dirty');
    expect(buildSaveRequest(target, null, adopted, profileUi.fields).body['version']).toBe(6);
  });

  it('a colleague saved in between (5, then 6, then the switch at 7): the form keeps 5', () => {
    const form = loadedAt(5);
    const kept = entitySaveReducer(form, { type: 'version', version: 7 });
    expect(kept).toBe(form);
    expect(buildSaveRequest(target, null, kept, profileUi.fields).body['version']).toBe(5);
  });

  it('never moves back, nor to a value that is not a version', () => {
    const form = loadedAt(5);
    for (const version of [5, 4, -1, 1.5, Number.NaN]) {
      expect(entitySaveReducer(form, { type: 'version', version }), String(version)).toBe(form);
    }
  });

  it('the screen adopts only what the switch reports it wrote', () => {
    const screen = readFileSync('src/components/admin/screens/general/GeneralScreen.tsx', 'utf8');
    expect(screen).toMatch(/onChanged=\{\(open, version, changed\) => \{/);
    expect(screen).toMatch(/if \(changed\) profile\.adoptVersion\(version\);/);
    const intakeRoute = readFileSync('src/pages/api/admin/site-profile/intake.ts', 'utf8');
    expect(intakeRoute).toContain('changed: false');
    expect(intakeRoute).toContain('changed: true');
  });
});

describe('the studio’s clock in the screens (Admin v2 U9)', () => {
  it('one clock per zone, the same object each time; an unlisted zone is the default', () => {
    expect(clockFor('Asia/Dubai')).toBe(clockFor('Asia/Dubai'));
    expect(clockFor('Europe/Paris').zone).toBe('Asia/Riyadh');
    expect(clockFor(null).zone).toBe('Asia/Riyadh');
  });

  it('prints the same moment in each zone’s wall time', () => {
    const at = '2026-10-15T21:30:00.000Z';
    expect(clockFor('Asia/Riyadh').formatDateTime(at)).toBe('16 Oct 2026, 00:30');
    expect(clockFor('Asia/Dubai').formatDateTime(at)).toBe('16 Oct 2026, 01:30');
    expect(clockFor('Europe/London').formatDateTime(at)).toBe('15 Oct 2026, 22:30');
    expect(clockFor('UTC').formatTime(at)).toBe('21:30');
    // "tomorrow" follows the zone's calendar.
    const now = '2026-10-15T20:30:00.000Z';
    expect(clockFor('UTC').relTime('2026-10-16T08:00:00.000Z', now)).toBe('tomorrow');
    expect(clockFor('Asia/Dubai').relTime('2026-10-16T08:00:00.000Z', now)).toBe('in 11 h');
  });

  it('"Saved at" is the provider’s zone, in the island and in the pure helper', () => {
    const at = '2026-10-15T21:30:00.000Z';
    expect(saveStatusText('saved', at, undefined, clockFor('Asia/Dubai'))).toBe('Saved at 01:30');
    const html = renderToStaticMarkup(
      createElement(ClockProvider, {
        tz: 'Europe/London',
        children: createElement(SaveStatus, { state: 'saved', savedAt: at }),
      }),
    );
    expect(html).toContain('Saved at 22:30');
  });
});

describe('the General screen’s words', () => {
  it('the logo tiles say why they cannot change, and spell no brand', () => {
    const html = renderToStaticMarkup(createElement(BrandFacts, { logoSrc: '/_image?x' }));
    expect(html).toContain(LOGO_NOTE);
    expect(html).toContain('alt="Logo"');
    expect(html).toContain('alt="Logo for light backgrounds"');
    expect(html).not.toMatch(/Braiin/i);
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('the applications switch: live for Admin, disabled with the reason for Developer', () => {
    const admin = renderToStaticMarkup(
      createElement(ApplicationsSwitch, {
        open: true,
        canChange: true,
        onChanged: () => undefined,
      }),
    );
    expect(admin).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(admin).not.toMatch(/role="switch"[^>]*disabled/);
    const developer = renderToStaticMarkup(
      createElement(ApplicationsSwitch, {
        open: false,
        canChange: false,
        onChanged: () => undefined,
      }),
    );
    expect(developer).toMatch(/role="switch"[^>]*disabled/);
    expect(developer).toContain(LOCKED_NOTE);
  });

  it('the page is the server’s gate and passes the island its zone; no style attribute', () => {
    const page = readFileSync('src/pages/admin/settings.astro', 'utf8');
    expect(page).toContain("can(session.role, 'settings.general') === 'full'");
    expect(page).toContain('tz={tz}');
    expect(page).not.toMatch(/\sstyle=/);
    const maintenance = readFileSync('src/pages/admin/maintenance.astro', 'utf8');
    expect(maintenance).toContain("can(session.role, 'maintenance.manage') === 'full'");
    expect(maintenance).toContain('tz={tz}');
  });
});

describe('the General e2e’s heading lookups each name one card (Playwright’s strict mode)', () => {
  // getByRole('heading', { name }) matches a case-insensitive SUBSTRING unless `exact`, and a
  // locator that matches two elements fails every assertion in strict mode. 'Site' also
  // matched the page's own "Site facts" card, so the first General test failed on every run
  // and serial mode skipped the rest, the maintenance project with it.
  const pageCard = readFileSync('src/pages/admin/settings.astro', 'utf8').match(
    /<Card title="([^"]+)"/g,
  );
  const titles = [
    ...(pageCard ?? []).map((t) => t.replace(/^<Card title="|"$/g, '')),
    ...[profileUi, settingsUi].flatMap((ui) => [
      ui.title,
      ...(ui.groups ?? []).map((g) => g.title),
    ]),
    'Job applications',
  ];
  const lookups = [
    ...readFileSync('tests/admin/general.e2e.ts', 'utf8').matchAll(
      /getByRole\('heading', \{ level: 2, name: '([^']+)'(, exact: true)? \}\)/g,
    ),
  ].map((m) => ({ name: m[1] ?? '', exact: Boolean(m[2]) }));

  it('the page’s own cards are among the candidates', () => {
    expect(titles).toContain('Site facts');
    expect(lookups.length).toBeGreaterThanOrEqual(3);
  });

  it.each(['Site', 'Contact', 'Social accounts'])('“%s” matches exactly one heading', (name) => {
    const lookup = lookups.find((l) => l.name === name);
    expect(lookup, name).toBeDefined();
    const matches = titles.filter((t) =>
      lookup!.exact ? t === name : t.toLowerCase().includes(name.toLowerCase()),
    );
    expect(matches, name).toEqual([name]);
  });
});

describe('the maintenance screen’s words', () => {
  it('Turn on says who still sees the site, and when that is nobody', () => {
    expect(turnOnText(true, 0)).toContain('Your signed in team still sees the site.');
    expect(turnOnText(false, 2)).toContain('Only the addresses you allow still see the site.');
    expect(turnOnText(false, 0)).toContain(
      'No address is allowed, so everyone sees it, you included.',
    );
    for (const text of [turnOnText(true, 0), turnOnText(false, 0)]) {
      expect(text).toContain('within about a minute');
      expect(text).not.toMatch(/[–—]/);
    }
  });

  it('the dialog: Cancel first and focused, Turn on as the danger button', () => {
    const html = renderToStaticMarkup(
      createElement(TurnOnDialog, {
        open: false,
        bypass: true,
        allowed: 0,
        onCancel: () => undefined,
        onConfirm: () => undefined,
      }),
    );
    expect(html.indexOf('Cancel')).toBeLessThan(html.indexOf('>Turn on<'));
    expect(html).toContain('data-autofocus');
  });

  it('the sketch draws the values, class-based, with the page’s built-in words', () => {
    const html = renderToStaticMarkup(
      createElement(MaintenanceSketch, {
        values: { background: 'black', showContact: false, showDate: true, until: '2026-11-03' },
      }),
    );
    expect(html).toContain('data-bg="black"');
    expect(html).toContain('We&#x27;re making something new.');
    expect(html).toContain('Back on 3 November');
    expect(html).not.toContain('WhatsApp');
    expect(html).not.toMatch(/\sstyle=/);
    expect(dayWords('2026-13-01')).toBe('');
  });
});

describe('the studio’s zone for a request (studioTimeZone)', () => {
  // Read through public.studio_time_zone() (0098), never the table: a Sales token (0097)
  // reads no site_settings row (app.is_staff() is the four CMS roles), so a table read would
  // answer Sales Riyadh while every colleague sees the studio's zone.
  const calls: string[] = [];
  const sb = (answer: { data: unknown; error: unknown }, table: unknown = null) =>
    ({
      // What a Sales token's table read gets: no row. The RPC answers every member.
      from: (name: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              calls.push(`from ${name}`);
              return { data: table, error: null };
            },
          }),
        }),
      }),
      rpc: async (fn: string, args?: unknown) => {
        calls.push(`rpc ${fn}${args === undefined ? '' : ` ${JSON.stringify(args)}`}`);
        return answer;
      },
    }) as never;
  beforeEach(() => {
    calls.length = 0;
  });

  it('reads once per request, through public.studio_time_zone(), the listed zone or the default', async () => {
    const { studioTimeZone, resetStudioTimeZoneWarning } =
      await import('@/lib/admin/studioTimeZone');
    resetStudioTimeZoneWarning();
    const locals = {
      supabase: sb({ data: 'Asia/Dubai', error: null }),
      session: { tenantId: 't', role: 'admin' },
    } as never;
    expect(await studioTimeZone(locals)).toBe('Asia/Dubai');
    expect(await studioTimeZone(locals)).toBe('Asia/Dubai');
    expect(calls).toEqual(['rpc studio_time_zone']);
    for (const answer of [
      { data: null, error: null },
      { data: 'Mars/Olympus', error: null },
      { data: null, error: { message: 'boom' } },
    ]) {
      expect(
        await studioTimeZone({ supabase: sb(answer), session: { tenantId: 't' } } as never),
      ).toBe('Asia/Riyadh');
    }
    expect(await studioTimeZone({ session: null } as never)).toBe('Asia/Riyadh');
  });

  it('a Sales session gets the studio’s zone too, though its table read finds no row', async () => {
    const { studioTimeZone } = await import('@/lib/admin/studioTimeZone');
    const locals = {
      supabase: sb({ data: 'Asia/Dubai', error: null }, null),
      session: { tenantId: 't', role: 'sales' },
    } as never;
    expect(await studioTimeZone(locals)).toBe('Asia/Dubai');
    expect(calls.some((c) => c.startsWith('from '))).toBe(false);
  });
});
