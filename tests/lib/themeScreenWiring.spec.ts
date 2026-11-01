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
//        Once the deferred render has caught up, the palette goes back into the form (the
//        write-back effect), so the save carries the colours the screen shows. A server render
//        runs no effect, so `react` is wrapped here: the write-back effect (the one that lists
//        the form's setter) is kept aside and run by hand, and the screen's first
//        `useState(false)`, the typed flag, can start true, as after a keystroke.
//   CR5  A first save (a create) opens this screen again, never the record's generic address
//        (/admin/themes/<id>, which only redirects here), through the save's own `leave`, which
//        lets the unsaved-changes guard go first (a bare window.location.assign met the
//        browser's "Leave site?", and a cancel left a new form whose next Save created twice).

const hook = vi.hoisted(() => {
  const set: [string, unknown][] = [];
  return {
    options: null as null | { onCreated?: (row: Record<string, unknown>) => void },
    leave: [] as string[],
    set,
    // One setter for every render, as the real hook's is (useCallback), so the write-back
    // effect can be told apart by its dependency list.
    setter: (name: string, value: unknown) => {
      set.push([name, value]);
    },
    values: {} as Record<string, unknown>,
  };
});
const rx = vi.hoisted(() => ({
  /** The write-back effects of the last render, to run by hand. */
  writeBack: [] as (() => unknown)[],
  /** Start the screen's typed flag (its first useState(false)) true on the next render. */
  typed: false,
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
      set: hook.setter,
      leave: (href: string) => hook.leave.push(href),
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
vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  return {
    ...real,
    useEffect: (effect: () => unknown, deps?: readonly unknown[]) => {
      if (deps?.includes(hook.setter)) rx.writeBack.push(effect);
      else real.useEffect(effect as () => void, deps);
    },
    useState: <T>(initial: T) => {
      if (rx.typed && initial === false) {
        rx.typed = false;
        return real.useState<boolean>(true);
      }
      return real.useState(initial);
    },
  };
});
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
const { withMain } = await import('@/components/admin/screens/theme/model');

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
  hook.set.length = 0;
  hook.leave = [];
  rx.writeBack = [];
  rx.typed = false;
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

describe('Simple mode: the palette goes back into the form (CR3)', () => {
  // The main colour as typed, with the default Hover and Accent: not yet its palette.
  const typed = {
    ...DEFAULT_THEME_SETTINGS,
    mode: 'simple' as const,
    colors: { ...DEFAULT_COLORS, primary: '#0B6EB0' },
  };

  it('once the deferred render has caught up, the form is given the palette it shows', () => {
    rx.typed = true;
    render(typed);
    expect(rx.typed).toBe(false);
    expect(rx.writeBack).toHaveLength(1);
    rx.writeBack[0]!();
    const sent = hook.set.filter(([name]) => name === 'settings').map(([, value]) => value);
    expect(sent).toEqual([withMain(typed, '#0B6EB0')]);
    expect(withMain(typed, '#0B6EB0').colors).not.toEqual(typed.colors);
  });

  it('nothing is written back when no main colour was typed (a loaded theme stays as saved)', () => {
    render(typed);
    expect(rx.writeBack).toHaveLength(1);
    rx.writeBack[0]!();
    expect(hook.set).toEqual([]);
  });
});

describe('the first save (CR5)', () => {
  const original = globalThis.window;
  afterEach(() => {
    globalThis.window = original;
  });

  it("opens this screen again, not /admin/themes/<id>, through the save's leave", () => {
    render(DEFAULT_THEME_SETTINGS);
    expect(THEME_SCREEN).toBe('/admin/appearance/theme');
    const onCreated = hook.options?.onCreated;
    expect(typeof onCreated).toBe('function');
    const assign = vi.fn();
    globalThis.window = { location: { assign } } as unknown as Window & typeof globalThis;
    onCreated!({ id: '00000000-0000-0000-0000-000000000001' });
    expect(hook.leave).toEqual(['/admin/appearance/theme']);
    // Never around the guard: a bare assign while the form is dirty meets "Leave site?".
    expect(assign).not.toHaveBeenCalled();
  });
});
