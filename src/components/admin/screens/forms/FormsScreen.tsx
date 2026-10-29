import { useId, useState } from 'react';
import EditorForm from '@/components/admin/fields/EditorForm';
import { saveModeFor } from '@/lib/admin/saveMode';
import { useEntitySave } from '@/lib/admin/useEntitySave';
import type { FieldDef } from '@/lib/admin/ui';
import { singletonHistory } from '@/lib/admin/historyTarget';
import {
  buttonCopy,
  fieldState,
  halfWritten,
  keyedCopy,
  moved,
  nextConsentVersion,
  orderOf,
  parseStored,
  serialise,
  withButton,
  withField,
  withKeyedCopy,
  withOrder,
  type Bilingual,
  type FieldMeta,
  type FieldState,
} from '@/lib/admin/forms/editor';

// The Forms editor (/admin/forms, Admin v2 E8): one form per tab, the inquiry form or the Join
// form, saved through the singleton kernel (`/api/admin/form-settings`, settings.general) with
// `useEntitySave` and `EditorForm`, so the explicit Save, the 409, release mode and the savebar
// work as in every staged editor. The form's column is a json field the form never draws
// (`hidden`); the cards below edit it and write it back as the smallest difference from the
// built-in form (src/lib/admin/forms/editor.ts). The server holds the result to the closed
// schema, and the public endpoints follow what is published.

export interface FormsScreenProps {
  form: 'inquiry' | 'join';
  /** Every field in the built-in order. */
  fields: readonly FieldMeta[];
  /** The Join form's groups, in order (none for the inquiry form). */
  groups?: readonly { id: string; title: string }[] | undefined;
  button: Bilingual;
  /** The inquiry form's budget bands, by key, with their built-in words. */
  budgets?: readonly { key: string; label: Bilingual }[] | undefined;
  /** The Join form's two consent lines, as built. */
  consent?: { application: Bilingual; futureRoles: Bilingual } | undefined;
  /** The recruitment notice's date (the version a form with its own lines posts). */
  notice?: string | undefined;
}

const TARGET = { kind: 'singleton', endpoint: '/api/admin/form-settings' } as const;

/** The forms config's history: the site's own (no id), as the identity's (R14-prep). */
const FORMS_HISTORY = singletonHistory('form_settings');

/** One bilingual line: English and Arabic inputs, each with its own label. */
function CopyPair({
  id,
  legend,
  value,
  builtIn,
  onChange,
  multiline = false,
  maxLength,
}: {
  id: string;
  legend: string;
  value: Bilingual;
  builtIn: Bilingual;
  onChange: (next: Bilingual) => void;
  multiline?: boolean;
  maxLength: number;
}) {
  const half = (lang: 'en' | 'ar') => {
    const props = {
      id: `${id}-${lang}`,
      lang,
      dir: lang === 'ar' ? 'rtl' : undefined,
      value: value[lang],
      maxLength,
      placeholder: builtIn[lang],
      onChange: (e: { target: { value: string } }) =>
        onChange({ ...value, [lang]: e.target.value }),
    };
    return (
      <div className="frm-half">
        <label
          htmlFor={`${id}-${lang}`}
          className="frm-lang"
          lang={lang === 'ar' ? 'ar' : undefined}
        >
          {lang === 'en' ? 'English' : 'العربية'}
        </label>
        {multiline ? <textarea rows={3} {...props} /> : <input type="text" {...props} />}
      </div>
    );
  };
  return (
    <fieldset className="frm-pair">
      <legend className="frm-legend">{legend}</legend>
      <div className="frm-halves">
        {half('en')}
        {half('ar')}
      </div>
      {halfWritten(value) && (
        <p className="f__cue">
          Write it in both languages, or clear both to use the built-in words.
        </p>
      )}
    </fieldset>
  );
}

export default function FormsScreen(props: FormsScreenProps) {
  const column = props.form === 'inquiry' ? 'inquiry' : 'application';
  const formName = props.form === 'inquiry' ? 'Inquiry form' : 'Join form';
  const fieldsDef: readonly FieldDef[] = [{ name: column, label: formName, kind: 'json', column }];
  // The database's count of consent rewordings, as the row last read or saved says.
  const [revision, setRevision] = useState(0);
  const save = useEntitySave(TARGET, null, {
    fields: fieldsDef,
    mode: saveModeFor(TARGET),
    onRow: (row) => {
      const n = Number(row['consent_revision']);
      setRevision(Number.isInteger(n) && n >= 0 ? n : 0);
    },
  });
  const base = useId();
  const config = parseStored(save.values[column]);
  const saved = parseStored(save.saved[column]);
  const set = (next: Record<string, unknown>) => save.set(column, serialise(next));
  const byKey = new Map(props.fields.map((f) => [f.key, f]));

  const fieldRow = (meta: FieldMeta, order: readonly string[], group?: string) => {
    const state = fieldState(config, meta);
    const update = (patch: Partial<FieldState>) =>
      set(withField(config, meta, { ...state, ...patch }));
    const at = order.indexOf(meta.key);
    const builtInOrder = props.fields
      .filter((f) => (group ? f.group === group : true))
      .map((f) => f.key);
    const move = (step: -1 | 1) =>
      set(withOrder(config, moved(order, meta.key, step), builtInOrder, group));
    const id = `${base}-${meta.key}`;
    return (
      <li key={meta.key} className="frm-row" data-field={meta.key}>
        <div className="frm-row__h">
          <span className="frm-row__t" id={`${id}-name`}>
            {meta.label.en}
          </span>
          {meta.where && <span className="frm-row__s">{meta.where}</span>}
          <span className="frm-row__moves">
            <button
              type="button"
              className="btn"
              data-variant="ghost"
              data-size="sm"
              disabled={at <= 0}
              aria-describedby={`${id}-name`}
              onClick={() => move(-1)}
            >
              Move up
            </button>
            <button
              type="button"
              className="btn"
              data-variant="ghost"
              data-size="sm"
              disabled={at < 0 || at >= order.length - 1}
              aria-describedby={`${id}-name`}
              onClick={() => move(1)}
            >
              Move down
            </button>
          </span>
        </div>
        <CopyPair
          id={`${id}-label`}
          legend={`Label for ${meta.label.en}`}
          value={state.label}
          builtIn={meta.label}
          maxLength={80}
          onChange={(label) => update({ label })}
        />
        {meta.optional ? (
          <div className="frm-checks">
            <label className="frm-check">
              <input
                type="checkbox"
                checked={state.visible}
                onChange={(e) => update({ visible: e.target.checked, required: false })}
              />
              Shown on the form
            </label>
            <label className="frm-check">
              <input
                type="checkbox"
                checked={state.required}
                disabled={!state.visible}
                onChange={(e) => update({ required: e.target.checked })}
              />
              Required
            </label>
          </div>
        ) : (
          <p className="f__cue">Always shown and required: the site needs it to answer.</p>
        )}
      </li>
    );
  };

  const list = (group?: string) => {
    const builtIn = props.fields
      .filter((f) => (group ? f.group === group : true))
      .map((f) => f.key);
    const order = orderOf(config, builtIn, group);
    return (
      <ul className="frm-rows">
        {order.map((key) => {
          const meta = byKey.get(key);
          return meta ? fieldRow(meta, order, group) : null;
        })}
      </ul>
    );
  };

  const version =
    props.consent && props.notice
      ? nextConsentVersion(props.notice, revision, saved, config)
      : null;

  const editor = (
    <div id={`f-${column}`} tabIndex={-1} className="frm-editor">
      <section className="card" aria-labelledby={`${base}-fields`}>
        <h2 className="card-title" id={`${base}-fields`}>
          Fields
        </h2>
        <p className="frm-note">
          The fields are fixed: change a label, the order, and whether an optional field is shown or
          required. The server checks every send against what is published.
        </p>
        {props.groups
          ? props.groups.map((g) => (
              <section key={g.id} className="frm-group" aria-labelledby={`${base}-g-${g.id}`}>
                <h3 className="frm-group__t" id={`${base}-g-${g.id}`}>
                  {g.title}
                </h3>
                {list(g.id)}
              </section>
            ))
          : list()}
      </section>
      <section className="card" aria-labelledby={`${base}-button`}>
        <h2 className="card-title" id={`${base}-button`}>
          Button
        </h2>
        <CopyPair
          id={`${base}-button-text`}
          legend="Button text"
          value={buttonCopy(config)}
          builtIn={props.button}
          maxLength={40}
          onChange={(v) => set(withButton(config, v, props.button))}
        />
      </section>
      {props.budgets && (
        <section className="card" aria-labelledby={`${base}-budgets`}>
          <h2 className="card-title" id={`${base}-budgets`}>
            Budget ranges
          </h2>
          <p className="frm-note">
            The ranges are fixed, so every inquiry stays comparable. Change the words each one
            shows.
          </p>
          {props.budgets.map((b) => (
            <CopyPair
              key={b.key}
              id={`${base}-budget-${b.key}`}
              legend={b.label.en}
              value={keyedCopy(config, 'budgets', b.key)}
              builtIn={b.label}
              maxLength={60}
              onChange={(v) => set(withKeyedCopy(config, 'budgets', b.key, v, b.label))}
            />
          ))}
        </section>
      )}
      {props.consent && (
        <section className="card" aria-labelledby={`${base}-consent`}>
          <h2 className="card-title" id={`${base}-consent`}>
            Consent
          </h2>
          <p className="frm-note">
            Each application keeps the version of the consent text its person agreed to. New wording
            gets a new version when it is saved, and the old wording stays in the history.{' '}
            {'{brand}'} is replaced with the studio&apos;s name.
          </p>
          <CopyPair
            id={`${base}-consent-application`}
            legend="Consent to this application (required box)"
            value={keyedCopy(config, 'consent', 'application')}
            builtIn={props.consent.application}
            maxLength={400}
            multiline
            onChange={(v) =>
              set(withKeyedCopy(config, 'consent', 'application', v, props.consent!.application))
            }
          />
          <CopyPair
            id={`${base}-consent-future`}
            legend="Consent to future roles (optional box)"
            value={keyedCopy(config, 'consent', 'futureRoles')}
            builtIn={props.consent.futureRoles}
            maxLength={200}
            multiline
            onChange={(v) =>
              set(withKeyedCopy(config, 'consent', 'futureRoles', v, props.consent!.futureRoles))
            }
          />
          {version && (
            <p className="frm-note">
              Version the form posts after saving: <span className="frm-version">{version}</span>
            </p>
          )}
        </section>
      )}
    </div>
  );

  return (
    <EditorForm
      save={save}
      fields={fieldsDef}
      hidden={[column]}
      submitLabel={`Save the ${formName.toLowerCase()}`}
      noun="forms config"
      history={FORMS_HISTORY}
      historyOf={{ label: formName, path: props.form === 'inquiry' ? '/contact' : '/join' }}
      after={editor}
    />
  );
}
