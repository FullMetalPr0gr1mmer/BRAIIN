import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import ColorField from '@/components/admin/fields/ColorField';
import EditorForm from '@/components/admin/fields/EditorForm';
import Note from '@/components/admin/kit/Note';
import Segmented from '@/components/admin/kit/Segmented';
import { confirmDialog } from '@/lib/admin/confirm';
import { historyTargetOf } from '@/lib/admin/historyTarget';
import { saveModeFor } from '@/lib/admin/saveMode';
import { useEntitySave, type EntitySave } from '@/lib/admin/useEntitySave';
import type { FieldDef } from '@/lib/admin/uiSchema';
import { themesUi } from '@/lib/admin/ui/themes';
import { contrast } from '@theme/colour';
import { DEFAULT_THEME_SETTINGS } from '@theme/compile';
import { suggestMain } from '@theme/gate';
import { THEME_ROLES, THEME_SWATCHES, type ThemeRole } from '@theme/palette';
import type { ThemeSettings } from '@schemas/theme';
import {
  ADMIN_PREVIEW_TOKENS,
  MARQUEE_OPTIONS,
  REVEAL_OPTIONS,
  ROLE_LABEL,
  cloneSettings,
  derivedSettings,
  failureLines,
  gateView,
  settingsOf,
  typedMain,
  withMain,
} from './model';
import SitePreview from './SitePreview';

// The theme editor (/admin/appearance/theme, Admin v2 E4, AV-27; ui.md "Theme"; the
// prototype's route('/appearance/theme')). theme.edit: Admin and Developer.
//
//   Brand colours  Simple: one main colour (or one of 8 swatches) makes the palette, the
//                  generated colours moved by the gate until they pass (packages/theme);
//                  Advanced: Primary, Hover and Accent one by one, "Generate the rest from
//                  Primary". Each chip shows how white text reads on it.
//   The gate       every failing pair in words, with a colour of the same hue that passes
//                  ("Use #0B6EB0 for Hover"); the server refuses a theme that fails anyway
//                  (the schema), and so does the database (custom_themes_theme_v1).
//   Motion         two settings that can only reduce motion.
//   Facts          what this version cannot change, read only.
//   Reset          the brand's own settings, after a danger confirm.
//
// The save is useEntitySave on the `themes` resource, with EditorForm drawing the save bar,
// the conflict, the draft notice and History: live with releases off, a pending change with
// them on (R12; a create marks itself staged in release mode, R12b). The admin previews the
// colours on itself through the CSSOM (style.setProperty on <html>, never a style attribute),
// only while they pass; the sample of the site is SVG painted by attributes.

export interface ThemeScreenProps {
  /** The tenant's v1 theme (live, or a pending create), or null: the first save creates it. */
  id: string | null;
  /** R12b: the screen is in release mode, so a create is staged. */
  releaseMode: boolean;
}

/** The fields the save carries (none drawn: the controls below edit `settings`). */
export const THEME_FIELDS: readonly FieldDef[] = themesUi.fields;

/** The screen's own address: a first save comes back here (E4 code review CR5). */
export const THEME_SCREEN = '/admin/appearance/theme';

/**
 * A first save created the theme: open this screen again, which now finds it (findThemeId, a
 * pending create included), rather than the record's generic address, /admin/themes/<id>,
 * which only redirects here (CR5). Through the save's own `leave`, which lets the
 * unsaved-changes guard go first: the form was dirty when Save was pressed and the guard is
 * still on as the create lands, so a bare window.location.assign met the browser's "Leave
 * site?", and a cancel left a new form whose next Save created a second theme (CR5
 * follow-up). The bare assign is only for a save without `leave` (a test's stand-in).
 */
export function reopenThemeScreen(leave: EntitySave['leave']): void {
  if (leave) leave(THEME_SCREEN);
  else window.location.assign(THEME_SCREEN);
}

// Primary and Hover carry white text (its contrast is the field's line); Accent is light text
// on black, which the palette chip below reports instead.
const colourField = (role: ThemeRole, swatches?: readonly string[]): FieldDef => ({
  name: role,
  label: ROLE_LABEL[role],
  kind: 'color',
  color: {
    ...(role === 'accent' ? {} : { contrastWith: '#FFFFFF' }),
    ...(swatches ? { swatches } : {}),
  },
});

export default function ThemeScreen({ id, releaseMode }: ThemeScreenProps) {
  const target = { kind: 'resource', slug: 'themes', staged: releaseMode } as const;
  // The save's `leave`, for the create's callback, which is handed to the hook before the
  // hook has answered (read when the create lands, long after this render).
  const leave = useRef<EntitySave['leave']>(undefined);
  const onCreated = useCallback(() => reopenThemeScreen(leave.current), []);
  const save = useEntitySave(target, id, {
    fields: THEME_FIELDS,
    mode: saveModeFor(target),
    defaults: {
      name: 'Site theme',
      settings: cloneSettings(DEFAULT_THEME_SETTINGS),
      isActive: true,
    },
    onCreated,
  });
  leave.current = save.leave;
  const settings = useMemo(() => settingsOf(save.values['settings']), [save.values]);
  // Simple mode's main colour goes into the form as typed (typedMain), so the box keeps up;
  // the palette made from it and the gate over it follow in a deferred render, which React
  // drops when a newer colour arrives: a picker drag fires about 60 input events a second, and
  // settling a palette is the slow part (E4 code review CR3). The pair is deferred together,
  // so a render never mixes one colour's settings with another's flag.
  const [mainTyped, setMainTyped] = useState(false);
  const urgent = useMemo(() => ({ settings, mainTyped }), [settings, mainTyped]);
  const deferred = useDeferredValue(urgent);
  const shown = useMemo(() => derivedSettings(deferred.settings, deferred.mainTyped), [deferred]);
  // The gate reads the colours only: the palette written back below costs no second run.
  const { primary: shownPrimary, hover: shownHover, accent: shownAccent } = shown.colors;
  const view = useMemo(
    () => gateView({ colors: { primary: shownPrimary, hover: shownHover, accent: shownAccent } }),
    [shownPrimary, shownHover, shownAccent],
  );
  // Once the deferred render has caught up with the newest colour, the palette goes into the
  // form, so the save carries the colours the screen shows.
  const setValue = save.set;
  useEffect(() => {
    if (deferred !== urgent || !deferred.mainTyped) return;
    setMainTyped(false);
    if (shown !== deferred.settings) setValue('settings', shown);
  }, [deferred, urgent, shown, setValue]);
  const set = (next: ThemeSettings) => {
    save.set('settings', next);
    // A saved theme is the active one: saving makes it the site's.
    if (save.values['isActive'] !== true) save.set('isActive', true);
  };
  const setColor = (role: ThemeRole, value: string) =>
    set({ ...settings, colors: { ...settings.colors, [role]: value } });

  // Simple mode's suggestion for the main colour, worked out after typing stops (it settles a
  // whole palette per lightness tried).
  const [mainPick, setMainPick] = useState<string | null>(null);
  const simpleFails = shown.mode === 'simple' && view.result !== null && !view.result.ok;
  useEffect(() => {
    setMainPick(null);
    if (!simpleFails) return;
    const timer = window.setTimeout(() => setMainPick(suggestMain(shownPrimary)), 250);
    return () => window.clearTimeout(timer);
  }, [simpleFails, shownPrimary]);

  // The admin wears the draft while it passes (CSSOM after hydration, ui.md §1.6), and the
  // live theme again (its stylesheet) when it does not or the screen goes.
  const passing = view.result?.ok === true ? view.palette : null;
  useEffect(() => {
    const root = document.documentElement.style;
    for (const role of THEME_ROLES) {
      if (passing) root.setProperty(ADMIN_PREVIEW_TOKENS[role], passing[role]);
      else root.removeProperty(ADMIN_PREVIEW_TOKENS[role]);
    }
  }, [passing]);
  useEffect(
    () => () => {
      for (const role of THEME_ROLES) {
        document.documentElement.style.removeProperty(ADMIN_PREVIEW_TOKENS[role]);
      }
    },
    [],
  );

  const reset = async () => {
    const ok = await confirmDialog({
      message:
        "Reset the theme? The brand's own colours and motion come back. Nothing changes on the site until you save.",
      confirmLabel: 'Reset',
    });
    if (ok) set({ ...cloneSettings(DEFAULT_THEME_SETTINGS), mode: settings.mode });
  };

  const lines = failureLines(view.result);
  const suggestions = view.result?.suggestions ?? {};
  const draftMode = save.mode === 'draft';

  return (
    <div className="theme">
      <EditorForm
        save={save}
        fields={THEME_FIELDS}
        hidden={['name', 'settings', 'isActive']}
        submitLabel="Save theme"
        noun="theme"
        history={historyTargetOf(target, id)}
        historyOf={{ label: 'Theme', path: '/' }}
      >
        <div className="theme__cols">
          <div className="theme__main">
            <section className="card" aria-labelledby="theme-colours">
              <div className="card__h">
                <div>
                  <h2 className="card__t" id="theme-colours">
                    Brand colours
                  </h2>
                  <p className="card__sub">
                    Primary fills buttons and colours links on the site and in this admin.
                  </p>
                </div>
              </div>
              <Segmented
                label="How do you want to set colours?"
                options={[
                  { value: 'simple', label: 'Simple: one colour', icon: 'sparkle' },
                  { value: 'advanced', label: 'Advanced: every colour', icon: 'palette' },
                ]}
                value={settings.mode}
                onChange={(mode) => set({ ...settings, mode })}
              />
              {settings.mode === 'simple' ? (
                <div className="theme__body">
                  <ColorField
                    field={{
                      ...colourField('primary', THEME_SWATCHES),
                      label: 'Main colour',
                      help: 'Hover and Accent are made from it.',
                    }}
                    value={settings.colors.primary}
                    onChange={(_name, value) => {
                      setMainTyped(true);
                      set(typedMain(settings, String(value ?? '')));
                    }}
                    idPrefix="theme"
                  />
                </div>
              ) : (
                <div className="theme__body">
                  {THEME_ROLES.map((role) => (
                    <ColorField
                      key={role}
                      field={colourField(role, role === 'primary' ? THEME_SWATCHES : undefined)}
                      value={settings.colors[role]}
                      onChange={(_name, value) => setColor(role, String(value ?? ''))}
                      idPrefix="theme"
                    />
                  ))}
                  <div>
                    <button
                      type="button"
                      className="btn"
                      data-size="sm"
                      onClick={() => set(withMain(settings, settings.colors.primary))}
                    >
                      Generate the rest from Primary
                    </button>
                  </div>
                </div>
              )}

              {view.palette && (
                <div className="theme__pal" role="group" aria-label="The palette the site wears">
                  {(
                    [
                      ['Primary', view.palette.primary],
                      ['Hover', view.palette.hover],
                      ['Accent', view.palette.accent],
                      ['Light accent tint', view.palette.skySoft],
                    ] as const
                  ).map(([name, hex]) => (
                    <div className="theme__chip" key={name}>
                      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
                        <rect x="0.5" y="0.5" width="39" height="39" rx="8" fill={hex} />
                      </svg>
                      <div>
                        <b>{name}</b>
                        <span className="theme__hex">{hex.toUpperCase()}</span>
                        <span className="admin-sub">
                          {name === 'Accent' || name === 'Light accent tint'
                            ? `On black: ${ratio(hex, '#000000')}`
                            : `White text: ${ratio('#ffffff', hex)}`}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {view.result && !view.result.ok && (
                <Note tone="err" role="alert">
                  <p>
                    <b>These colours are hard to read, so the theme cannot be saved yet.</b>
                  </p>
                  <ul className="theme__fails">
                    {lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  <div className="toolbar">
                    {settings.mode === 'simple'
                      ? mainPick && (
                          <button
                            type="button"
                            className="btn"
                            data-size="sm"
                            onClick={() => set(withMain(settings, mainPick))}
                          >
                            Use {mainPick} as the main colour instead
                          </button>
                        )
                      : THEME_ROLES.map((role) =>
                          suggestions[role] ? (
                            <button
                              key={role}
                              type="button"
                              className="btn"
                              data-size="sm"
                              onClick={() => setColor(role, suggestions[role]!)}
                            >
                              Use {suggestions[role]} for {ROLE_LABEL[role]} instead
                            </button>
                          ) : null,
                        )}
                  </div>
                </Note>
              )}
            </section>

            <section className="card" aria-labelledby="theme-motion">
              <div className="card__h">
                <div>
                  <h2 className="card__t" id="theme-motion">
                    Motion
                  </h2>
                  <p className="card__sub">These can only make the site calmer.</p>
                </div>
              </div>
              <div className="theme__body">
                <div className="theme__row">
                  <span className="theme__label" aria-hidden="true">
                    Clients marquee speed
                  </span>
                  <Segmented
                    label="Clients marquee speed"
                    options={MARQUEE_OPTIONS}
                    value={settings.motion.marquee}
                    onChange={(marquee) =>
                      set({ ...settings, motion: { ...settings.motion, marquee } })
                    }
                  />
                </div>
                <div className="theme__row">
                  <span className="theme__label" aria-hidden="true">
                    Sections
                  </span>
                  <Segmented
                    label="Sections"
                    options={REVEAL_OPTIONS}
                    value={settings.motion.reveal ? 'on' : 'off'}
                    onChange={(value) =>
                      set({ ...settings, motion: { ...settings.motion, reveal: value === 'on' } })
                    }
                  />
                </div>
              </div>
            </section>

            <section className="card" aria-labelledby="theme-facts">
              <div className="card__h">
                <div>
                  <h2 className="card__t" id="theme-facts">
                    What stays the same
                  </h2>
                </div>
              </div>
              <dl className="theme__facts">
                <div>
                  <dt>Fonts</dt>
                  <dd>
                    Archivo for English and Almarai for Arabic, served from the site itself. Another
                    font needs a developer.
                  </dd>
                </div>
                <div>
                  <dt>Backgrounds</dt>
                  <dd>The black sections, the light sections and white stay as they are.</dd>
                </div>
                <div>
                  <dt>Reduced motion</dt>
                  <dd>
                    Visitors who ask their device for less motion get it automatically. There is no
                    smooth scrolling or parallax.
                  </dd>
                </div>
              </dl>
              <div className="toolbar">
                <button
                  type="button"
                  className="btn"
                  data-variant="danger"
                  onClick={() => void reset()}
                >
                  Reset to brand defaults
                </button>
              </div>
            </section>
          </div>

          <aside className="theme__side" aria-labelledby="theme-preview">
            <section className="card">
              <div className="card__h">
                <div>
                  <h2 className="card__t" id="theme-preview">
                    Preview
                  </h2>
                  <p className="card__sub">
                    A part of the site in these colours. This admin follows them too while they
                    pass.
                  </p>
                </div>
              </div>
              {view.palette ? (
                <SitePreview palette={view.palette} />
              ) : (
                <p className="admin-sub">Finish typing a colour to see it.</p>
              )}
              {draftMode && (
                <p className="admin-sub">
                  <a href="/admin/preview/" target="_blank" rel="noopener">
                    Open the site with your pending changes
                  </a>
                </p>
              )}
            </section>
          </aside>
        </div>
      </EditorForm>
    </div>
  );
}

const ratio = (a: string, b: string) => `${(Math.floor(contrast(a, b) * 10) / 10).toFixed(1)}:1`;
