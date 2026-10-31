import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { compileTheme } from '@theme/compile';
import { contrast } from '@theme/colour';
import { ratioText } from '@theme/gate';
import { themeResource } from '@/lib/admin/resources/themes';
import { translateWriteError } from '@/lib/admin/crud';
import { makeContext, serviceClientStub, TENANT, UUID } from '../authz/harness';

// The theme's save, past assertCap (Admin v2 E4, AV-27): the matrix (tests/authz/cases/
// appearance.ts) proves who is refused; this proves what an Admin's or a Developer's save does
// once let through. The server compiles the tokens from the settings on every save, so a
// client never writes one (a `tokens` key sent anyway is dropped); a theme that fails the
// contrast gate is a 422 naming the pair, and nothing is written; the database's own two
// refusals read as a 422 on the settings.

const audits: { action: string; detail?: unknown }[] = [];
vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _auth: unknown, entry: (typeof audits)[number]) => {
    audits.push(entry);
    return true;
  },
}));
vi.mock('@/lib/supabase/server', () => ({ serviceClient: serviceClientStub }));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const collection = (await import('@/pages/api/admin/themes/index')) as Record<'POST', APIRoute>;
const item = (await import('@/pages/api/admin/themes/[id]')) as Record<'PATCH', APIRoute>;

const SETTINGS = {
  v: 1,
  mode: 'advanced',
  colors: { primary: '#000000', hover: '#615757', accent: '#938a8d' },
  motion: { marquee: 'slower', reveal: false },
};
const SAVED = { ...SETTINGS, colors: { ...SETTINGS.colors, accent: '#938A8D' } };

interface Write {
  op: 'insert' | 'update';
  values: Record<string, unknown>;
}

/** A PostgREST stand-in that records each write and answers with the row it was given. */
function recordingClient() {
  const writes: Write[] = [];
  let last: Record<string, unknown> = { id: UUID, version: 1 };
  const builder: Record<string, unknown> = {};
  for (const op of ['select', 'eq', 'neq', 'not', 'order', 'limit', 'range', 'is']) {
    builder[op] = () => builder;
  }
  for (const op of ['insert', 'update'] as const) {
    builder[op] = (values: Record<string, unknown>) => {
      writes.push({ op, values });
      last = { id: UUID, version: 2, ...values };
      return builder;
    };
  }
  builder['single'] = async () => ({ data: last, error: null });
  builder['maybeSingle'] = async () => ({ data: last, error: null });
  builder['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolve({ data: [], error: null, count: 0 }));
  return {
    client: { from: () => builder, rpc: async () => ({ data: null, error: null }) },
    writes,
  };
}

async function call(
  role: 'admin' | 'developer',
  method: 'POST' | 'PATCH',
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown>; writes: Write[] }> {
  const url = method === 'POST' ? '/api/admin/themes' : `/api/admin/themes/${UUID}`;
  const ctx = makeContext(role, url, body, method);
  const { client, writes } = recordingClient();
  (ctx.locals as unknown as { supabase: unknown }).supabase = client;
  const route = method === 'POST' ? collection.POST : item.PATCH;
  const res = (await route(ctx)) as Response;
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, writes };
}

beforeEach(() => {
  audits.length = 0;
});

describe('a theme save compiles its tokens on the server', () => {
  it.each(['admin', 'developer'] as const)(
    '%s: the first save creates it, tokens compiled',
    async (role) => {
      const { status, writes } = await call(role, 'POST', {
        name: 'Site theme',
        settings: SETTINGS,
        // Sent anyway: not part of the shape, dropped.
        tokens: { '--bs-klein': '#ff0000', '--x': 'red' },
      });
      expect(status).toBe(200);
      const insert = writes.find((w) => w.op === 'insert')!;
      expect(insert.values).toEqual({
        name: 'Site theme',
        is_active: true,
        settings: SAVED,
        tokens: compileTheme(SAVED as never),
        tenant_id: TENANT,
      });
      expect(insert.values['tokens']).toMatchObject({ '--bs-klein': '#000000' });
      // Saving makes it the site's: the others are switched off after the write.
      expect(writes.filter((w) => w.op === 'update')).toEqual([
        { op: 'update', values: { is_active: false } },
      ]);
    },
  );

  it('a later save writes the settings and the tokens together, never one alone', async () => {
    const { status, writes } = await call('developer', 'PATCH', { settings: SETTINGS, version: 1 });
    expect(status).toBe(200);
    const update = writes.find((w) => w.op === 'update' && 'settings' in w.values)!;
    expect(update.values['settings']).toEqual(SAVED);
    expect(update.values['tokens']).toEqual(compileTheme(SAVED as never));
  });

  it('a rename alone touches neither', async () => {
    const { status, writes } = await call('admin', 'PATCH', { name: 'Autumn', version: 1 });
    expect(status).toBe(200);
    const update = writes.find((w) => w.op === 'update')!;
    expect(update.values).toEqual({ name: 'Autumn' });
  });

  it('the brand’s own settings save with no token (Reset to brand defaults)', async () => {
    const { status, writes } = await call('admin', 'PATCH', {
      settings: {
        v: 1,
        mode: 'simple',
        colors: { primary: '#0024BC', hover: '#024CFF', accent: '#22A9FF' },
        motion: { marquee: 'normal', reveal: true },
      },
      version: 1,
    });
    expect(status).toBe(200);
    expect(writes.find((w) => w.op === 'update')!.values['tokens']).toEqual({});
  });
});

describe('what a save refuses, before anything is written', () => {
  it('colours that fail the gate: 422, the pair in words on the colour', async () => {
    const { status, json, writes } = await call('admin', 'POST', {
      settings: { ...SETTINGS, colors: { ...SETTINGS.colors, hover: '#7FB2FF' } },
    });
    expect(status).toBe(422);
    expect(writes).toEqual([]);
    const text = JSON.stringify(json);
    expect(text).toContain(
      `White text on Hover is ${ratioText(contrast('#ffffff', '#7fb2ff'))}, needs 4.5:1`,
    );
    expect(text).toContain('hover');
  });

  it.each([
    ['a half-typed colour', { ...SETTINGS, colors: { ...SETTINGS.colors, primary: '#00' } }],
    ['custom CSS', { ...SETTINGS, css: 'body{display:none}' }],
    ['a faster marquee', { ...SETTINGS, motion: { marquee: 'faster', reveal: true } }],
    ['another version', { ...SETTINGS, v: 2 }],
    ['no settings at all', undefined],
  ])('%s: 422, nothing written', async (_name, settings) => {
    const { status, writes } = await call('admin', 'POST', { settings });
    expect(status).toBe(422);
    expect(writes).toEqual([]);
  });
});

describe('the database’s refusals read as the editor’s', () => {
  const { constraintFields } = themeResource;
  it('a second theme, and a CHECK refusal, are 422s on the settings', () => {
    const duplicate = translateWriteError(
      {
        code: '23505',
        message: 'duplicate key value violates unique constraint "custom_themes_one_theme_v1"',
      },
      'custom_themes',
      'write',
      constraintFields,
    );
    expect(duplicate).toMatchObject({ field: 'settings' });
    expect(duplicate.message).toContain('already has a theme');
    const check = translateWriteError(
      {
        code: '23514',
        message:
          'new row for relation "custom_themes" violates check constraint "custom_themes_theme_v1"',
      },
      'custom_themes',
      'write',
      constraintFields,
    );
    expect(check).toMatchObject({ field: 'settings' });
    expect(check.message).toContain('hard to read');
  });
});
