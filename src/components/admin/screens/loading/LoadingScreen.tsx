import { useCallback, useEffect, useId, useState } from 'react';
import EditorForm from '@/components/admin/fields/EditorForm';
import FieldShell, { describedBy } from '@/components/admin/fields/FieldShell';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';
import { adminFetch, describeError } from '@/lib/admin/client';
import { singletonHistory } from '@/lib/admin/historyTarget';
import {
  announcePending,
  onDraftsMoved,
  readsThroughRelease,
  stagedBody,
} from '@/lib/admin/releaseEvents';
import { saveModeFor } from '@/lib/admin/saveMode';
import { toast } from '@/lib/admin/toast';
import { BACKDROP_LABELS, loadingUi } from '@/lib/admin/ui/loading';
import { useEntitySave } from '@/lib/admin/useEntitySave';
import { pendingOf, rowWrite } from '../header/menu';
import {
  contentOf,
  homeHero,
  introShown,
  previewLine,
  previewLook,
  switchedContent,
  type HomeHero,
  type PreviewLook,
} from './model';

// The Loading screen (/admin/appearance/loading, Admin v2 E7; ui.md "### Loading screen", the
// prototype's `route('/appearance/loading')`). Two parts, each for its own capability (P-9,
// O-14):
//   - On the home page (pages.write: Admin, Content Creator): "Show the loading screen", the
//     home page's first visible hero section's `intro`, one versioned PATCH of the section
//     kernel (in release mode it names the section's pending change or carries the marker,
//     R12b), exactly what the page editor's Advanced JSON wrote before;
//   - the look (theme.edit: Admin, Developer): the Style card (what sits behind the logo, as
//     tiles; the bar; the tagline) and the Timing card (the hold and the fade, in the site's
//     buckets) over `site_appearance`'s intro_ columns, saved through the Header's singleton
//     (`/api/admin/site-appearance`, which writes only the keys a save names) with useEntitySave
//     and EditorForm, so the explicit Save, the 409, release mode and History work as in every
//     staged editor; beside them a preview that plays the choreography from the form as it is,
//     before it is saved, and what is always true.

export interface LoadingScreenProps {
  /** theme.edit: the look. */
  theme: boolean;
  /** pages.write: the on/off switch. */
  pages: boolean;
  /** The home page's id (read on the server under the person's RLS), or null. */
  homePageId: string | null;
  /** The server's read of the home page failed (so null above says nothing). */
  homeError: boolean;
  /** The logo, as the admin serves it (same origin), for the tiles and the preview. */
  logoSrc: string;
}

type Row = Record<string, unknown>;

const UI = loadingUi;
const TARGET = { kind: 'singleton', endpoint: UI.endpoint } as const;
/** The look's history: the row's own (no id), shared with the header's options (R14-prep). */
const HISTORY = singletonHistory('site_appearance');
const HISTORY_OF = { label: 'Header and loading screen', path: '/' } as const;
/** Every field but the backdrop, which the Style card draws as tiles (a module constant). */
const FORM_FIELDS = UI.fields.filter((f) => f.name !== 'backdrop');
const BACKDROPS = Object.keys(BACKDROP_LABELS) as (keyof typeof BACKDROP_LABELS)[];
/** The most sections the switch's read asks for (ListQuerySchema's limit). */
const SECTION_PAGE = 100;

// ── On the home page (pages.write) ─────────────────────────────────────────────────────────

type SwitchState =
  | { kind: 'loading' }
  | { kind: 'nohome' }
  | { kind: 'nohero' }
  | { kind: 'failed' }
  | { kind: 'ready'; hero: HomeHero; content: Row; staged: boolean };

function IntroSwitch({ homePageId, homeError }: { homePageId: string | null; homeError: boolean }) {
  const base = useId();
  const id = `${base}-intro`;
  const [state, setState] = useState<SwitchState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (homeError) {
      setState({ kind: 'failed' });
      setError('The home page could not be read. Reload the page to try again.');
      return;
    }
    if (!homePageId) {
      setState({ kind: 'nohome' });
      return;
    }
    try {
      const list = await adminFetch<Row>(
        `/api/admin/sections?page_id=${encodeURIComponent(homePageId)}&limit=${SECTION_PAGE}`,
      );
      const rows = Array.isArray(list['rows']) ? (list['rows'] as Row[]) : [];
      const hero = homeHero(rows);
      if (!hero) {
        setState({ kind: 'nohero' });
        return;
      }
      // The list carries no content: the hero's own read does (live, or with its pending
      // change laid over it in release mode).
      const row = await adminFetch<Row>(`/api/admin/sections/${encodeURIComponent(hero.id)}`);
      setState({
        kind: 'ready',
        hero: {
          id: hero.id,
          version: Number(row['version'] ?? hero.version),
          pending: pendingOf(row) ?? hero.pending,
        },
        content: contentOf(row),
        staged: readsThroughRelease(list),
      });
      setError('');
    } catch (err) {
      setError(`The home page could not be read. ${describeError(err)}`);
      setState((current) => (current.kind === 'ready' ? current : { kind: 'failed' }));
    }
  }, [homePageId, homeError]);

  useEffect(() => {
    void load();
  }, [load]);

  // Releases on: a pending change settled or thrown away elsewhere moved what the switch reads.
  const staged = state.kind === 'ready' && state.staged;
  useEffect(() => (staged ? onDraftsMoved(() => void load()) : undefined), [staged, load]);

  async function toggle() {
    if (state.kind !== 'ready') return;
    const on = !introShown(state.content);
    setBusy(true);
    let failure = '';
    try {
      const write = rowWrite(
        { content: switchedContent(state.content, on) },
        state.hero,
        state.staged,
      );
      const answer = await adminFetch<Row>(`/api/admin/sections/${state.hero.id}`, {
        method: 'PATCH',
        body: stagedBody(write.body, write.mark),
      });
      if (answer['draft']) announcePending();
      toast(on ? 'The loading screen shows on the home page.' : 'The loading screen is off.', 'ok');
    } catch (err) {
      failure = `That was not saved. ${describeError(err)}`;
    }
    await load();
    if (failure) setError(failure);
    setBusy(false);
  }

  const on = state.kind === 'ready' ? introShown(state.content) : false;
  const hint =
    state.kind === 'nohero'
      ? 'The home page shows no hero section, so it has no loading screen. Add a hero to the home page in Pages.'
      : state.kind === 'nohome'
        ? 'This site has no home page in Pages yet, so it shows the built-in one, with its loading screen.'
        : 'The logo plays before the home page appears, in English and Arabic. Saved with the home page, like any edit of it.';
  return (
    <section className="card" aria-labelledby={`${base}-title`}>
      <div className="card__h">
        <h2 className="card-title" id={`${base}-title`}>
          On the home page
        </h2>
      </div>
      {error ? (
        <Note tone="err" role="alert">
          {error}
        </Note>
      ) : null}
      <FieldShell id={id} label="Show the loading screen" hint={hint} inline>
        <button
          type="button"
          role="switch"
          id={id}
          aria-checked={on}
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy(id, { hint })}
          disabled={busy || state.kind !== 'ready'}
          onClick={() => void toggle()}
        />
      </FieldShell>
    </section>
  );
}

// ── The look (theme.edit) ──────────────────────────────────────────────────────────────────

/** The plate, small: one closed data-* value per option (CSP: no style attribute). */
function Plate({ look, logoSrc, play }: { look: PreviewLook; logoSrc: string; play: boolean }) {
  return (
    <div
      className="ld-pv__plate"
      data-backdrop={look.backdrop}
      data-hold={look.holdMs}
      data-fade={look.fadeMs}
      data-play={play ? '' : undefined}
    >
      <img className="ld-pv__logo" src={logoSrc} alt="" width={130} height={67} />
      {look.tagline !== '' || look.bar ? (
        <span className="ld-pv__below">
          {look.tagline !== '' ? <span className="ld-pv__tag">{look.tagline}</span> : null}
          {look.bar ? (
            <span className="ld-pv__bar">
              <i />
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function StyleTiles({
  value,
  onChange,
  logoSrc,
  error,
}: {
  value: PreviewLook['backdrop'];
  onChange: (value: string) => void;
  logoSrc: string;
  error: string | undefined;
}) {
  const name = `${useId()}-backdrop`;
  return (
    <FieldShell id="f-backdrop" label="Behind the logo" as="fieldset" required error={error}>
      <div className="ld-tiles">
        {BACKDROPS.map((key) => (
          <label key={key} className="ld-tile">
            <span className="ld-tile__pv" data-backdrop={key} aria-hidden="true">
              <img src={logoSrc} alt="" width={64} height={33} />
            </span>
            <span className="ld-tile__lb">
              <input
                type="radio"
                name={name}
                value={key}
                checked={value === key}
                aria-describedby={describedBy('f-backdrop', { error })}
                onChange={() => onChange(key)}
              />
              {BACKDROP_LABELS[key]}
            </span>
          </label>
        ))}
      </div>
    </FieldShell>
  );
}

function Preview({ look, logoSrc }: { look: PreviewLook; logoSrc: string }) {
  // A press plays the look it was pressed for; a change to the form shows it still again.
  const shape = JSON.stringify(look);
  const [played, setPlayed] = useState<{ shape: string; run: number } | null>(null);
  const run = played !== null && played.shape === shape ? played.run : 0;
  const line = previewLine(look);
  return (
    <figure className="ld-pv">
      <div className="ld-pv__stage" aria-hidden="true">
        <div className="ld-pv__hero">
          <span />
          <span />
        </div>
        <Plate key={run} look={look} logoSrc={logoSrc} play={run > 0} />
      </div>
      <figcaption className="ld-pv__cap">{line}</figcaption>
      <button
        type="button"
        className="btn"
        data-size="sm"
        onClick={() => setPlayed((p) => ({ shape, run: (p?.run ?? 0) + 1 }))}
      >
        <Icon name="play" size={14} />
        Play preview
      </button>
      <p className="ld-pv__note">
        A small copy of the opening of the home page. If this device asks for less motion, the
        preview stays still.
      </p>
    </figure>
  );
}

function Facts() {
  return (
    <ul className="ld-facts">
      <li>
        <Icon name="eye" size={14} />
        <span>Visitors see it once per visit, in each tab.</span>
      </li>
      <li>
        <Icon name="mobile" size={14} />
        <span>Any tap, key or scroll skips it.</span>
      </li>
      <li>
        <Icon name="eyeoff" size={14} />
        <span>Visitors who ask for less motion never see it.</span>
      </li>
      <li>
        <Icon name="image" size={14} />
        <span>
          The logo always shows: it is the first thing the home page draws, so it stays the same
          whatever the style.
        </span>
      </li>
    </ul>
  );
}

function LoadingOptions({ logoSrc }: { logoSrc: string }) {
  const save = useEntitySave(TARGET, null, { fields: UI.fields, mode: saveModeFor(TARGET) });
  const look = previewLook(save.values);
  return (
    <EditorForm
      save={save}
      fields={FORM_FIELDS}
      groups={UI.groups}
      submitLabel="Save the loading screen"
      noun="loading screen"
      history={HISTORY}
      historyOf={HISTORY_OF}
      slots={{
        style: (
          <StyleTiles
            value={look.backdrop}
            onChange={(value) => save.set('backdrop', value)}
            logoSrc={logoSrc}
            error={save.errors.byId['f-backdrop']}
          />
        ),
        preview: <Preview look={look} logoSrc={logoSrc} />,
        facts: <Facts />,
      }}
    />
  );
}

export default function LoadingScreen({
  theme,
  pages,
  homePageId,
  homeError,
  logoSrc,
}: LoadingScreenProps) {
  return (
    <div className="ld">
      {pages ? <IntroSwitch homePageId={homePageId} homeError={homeError} /> : null}
      {theme ? <LoadingOptions logoSrc={logoSrc} /> : null}
    </div>
  );
}
