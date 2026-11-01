import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_THEME_SETTINGS } from '@theme/compile';
import { DEFAULT_COLORS } from '@theme/palette';

// The theme editor's wiring (Admin v2 E4, E4 code review CR3 and CR5), with the save hook and
// the colour field stubbed so their props can be driven in node (the repo has no DOM test
// environment; the browser journey is tests/admin/theme.e2e.ts):
//   CR3  Simple mode's main colour goes into the form as typed, and nothing more: the palette
//        made from it (simplePalette, which settles it against the gate, the slow part) is
//        never worked out on the input event itself, about 60 a second during a picker drag;
//        it follows in a deferred render (model.ts derivedSettings, tests/lib/themeEditor).
//   CR5  A first save (a create) opens this screen again, never the record's generic address
//        (/admin/themes/<id>, which only redirects here).

const hook = vi.hoisted(() => ({
  options: null as null | { onCreated?: (row: Record<string, unknown>) => void },
  set: [] as [string, unknown][],
  values: {} as Record<string, unknown>,
}));
const fields = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
const palette = vi.hoisted(() => ({ calls: 0 }));

vi.mock('@/lib/admin/useEntitySave', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useEntitySave: (_target: unknown, _id: unknown, options: typeof hook.options) => {
    hook.options = options;
    return {
      isNew: true,
      values: hook.values,
      saved: hook.values,
      set: (name: string, value: unknown) => hook.set.push([name, value]),
      version: 0,
      busy: false,
      loadError: null,
      status: 'idle',
      savedAt: null,
      errors: { byId: {}, summary: [] },
      conflict: false,
      edgeMissed: false,
      dirty: false,
      message: null,
      mode: 'live',
      save: async () => true,
      reloadTheirs: async () => undefined,
      adoptVersion: () => undefined,
    };
  },
}));
vi.mock('@/components/admin/fields/ColorField', () => ({
  default: (props: Record<string, unknown>) => {
    fields.props.push(props);
    return null;
  },
}));
vi.mock('@theme/gate', async (importOriginal) => {
  const real = await importOriginal<typeof import('@theme/gate')>();
  return {
    ...real,
    simplePalette: (primary: string) => {
      palette.calls += 1;
      return real.simplePalette(primary);
    },
  };
});

const { default: ThemeScreen, THEME_SCREEN } =
  await import('@/components/admin/screens/theme/ThemeScreen');

type FieldProps = {
  field: { label: string };
  onChange: (name: string, value: unknown) => void;
};

function render(settings: unknown): FieldProps[] {
  hook.values = { name: 'Site theme', settings, isActive: true };
  fields.props = [];
  renderToStaticMarkup(createElement(ThemeScreen, { id: null, releaseMode: false }));
  return fields.props as unknown as FieldProps[];
}

beforeEach(() => {
  hook.options = null;
  hook.set = [];
  palette.calls = 0;
});

describe('Simple mode: the main colour, as typed (CR3)', () => {
  it('goes into the form at once, with no palette worked out on the input event', () => {
    const [main] = render({ ...DEFAULT_THEME_SETTINGS, mode: 'simple' });
    expect(main?.field.label).toBe('Main colour');
    palette.calls = 0;
    main!.onChange('primary', '#0B6EB0');
    expect(palette.calls).toBe(0);
    const sent = hook.set.find(([name]) => name === 'settings')?.[1] as {
      colors: Record<string, string>;
    };
    // Hover and Accent wait for the deferred render: the event changed the main colour only.
    expect(sent.colors).toEqual({ ...DEFAULT_COLORS, primary: '#0B6EB0' });
  });

  it('a half-typed colour is kept as typed', () => {
    const [main] = render({ ...DEFAULT_THEME_SETTINGS, mode: 'simple' });
    main!.onChange('primary', '#0B');
    const sent = hook.set.find(([name]) => name === 'settings')?.[1] as {
      colors: Record<string, string>;
    };
    expect(sent.colors['primary']).toBe('#0B');
  });
});

describe('the first save (CR5)', () => {
  const original = globalThis.window;
  afterEach(() => {
    globalThis.window = original;
  });

  it('opens this screen again, not /admin/themes/<id>', () => {
    render(DEFAULT_THEME_SETTINGS);
    expect(THEME_SCREEN).toBe('/admin/appearance/theme');
    const onCreated = hook.options?.onCreated;
    expect(typeof onCreated).toBe('function');
    const assign = vi.fn();
    globalThis.window = { location: { assign } } as unknown as Window & typeof globalThis;
    onCreated!({ id: '00000000-0000-0000-0000-000000000001' });
    expect(assign).toHaveBeenCalledWith('/admin/appearance/theme');
  });
});
