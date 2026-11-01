import { Suspense, createContext, lazy, useContext, type ReactNode } from 'react';
import type { TiptapDoc } from '@schemas/tiptap';
import type { FieldErrors } from '@/lib/admin/fieldErrors';
import type { FieldDef } from '@/lib/admin/uiSchema';

// The rich-text editor is Tiptap plus ProseMirror, about 100 KB gzipped: loaded with
// import() so only a form that HAS a rich-text field downloads it (the admin-rich chunk,
// astro.config.mjs). scripts/admin-bundle.mjs, run by `npm run size` on the build, fails
// if any screen loads it eagerly.
const RichText = lazy(() => import('./RichText'));
import RelationField from './fields/RelationField';
import MediaField from './fields/MediaField';
import RepeaterField, { type RenderField } from './fields/RepeaterField';
import ObjectField from './fields/ObjectField';
import ClipField from './fields/ClipField';
import SectionContentField from './fields/SectionContentField';
import UploadField from './fields/UploadField';
import AccentField from './fields/AccentField';
import BilingualField from './fields/BilingualField';
import SwitchField from './fields/SwitchField';
import ColorField from './fields/ColorField';
import LinkField from './fields/LinkField';
import SlugRelationField from './fields/SlugRelationField';
import RangeField from './fields/RangeField';
import ChipsField from './fields/ChipsField';
import GalleryField from './fields/GalleryField';
import FieldShell, { describedBy } from './fields/FieldShell';
import LinkDialog from './fields/LinkDialog';
import { useArabicGap, useFieldLanguage } from './fields/editorLanguage';
import { richTextArabicGap } from '@/lib/admin/docWords';
import Segmented from './kit/Segmented';

// One renderer per field kind, shared by every editor (EditorForm: ResourceForm and
// SingletonForm today, every Wave 3 screen next).
//
// Shared on purpose. The two forms have different save paths (collection vs singleton),
// but if they each rendered their own inputs, "bilingual" would eventually mean two
// inputs in one and one input in the other — and the half that lost its Arabic field
// would keep passing every test, because the server accepts a partial PATCH. So this is
// the one switch over the kinds: each kind's component lives in ./fields/ (the field kit,
// Admin v2 F5a) and takes the same props (fields/types.ts), and the element ids are
// `<idPrefix>-<name>` (`-en`/`-ar` for a language), which the API's error paths map onto
// (src/lib/admin/fieldErrors.ts). No `style=` anywhere (CSP: §3 Pillar 1).

export type Row = Record<string, unknown>;

/**
 * Admin v2 U8b: the fields are shown read-only (EditorForm `readOnly`). The disabled
 * <fieldset> around them turns every input, select and button off, but a contenteditable
 * ignores it, so the rich text reads this and is created not editable, with no toolbar.
 */
export const FieldsReadOnly = createContext(false);

export interface FieldProps {
  field: FieldDef;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
  /** The whole form's values — a `sectionContent` field reads its sibling `type`. */
  values?: Row;
  /** Keeps element ids unique when the same field renders inside repeater items. */
  idPrefix?: string;
  /** Inline messages by element id, from the API's issues (fieldErrors.ts). */
  errors?: FieldErrors | undefined;
  /** F5b: what the field shows when nothing is stored (a section's built-in copy). */
  builtIn?: unknown;
  /** F5b: "Advanced (JSON)" on section content is offered (Admin, D5). */
  canAdvanced?: boolean | undefined;
}

export function Field({
  field,
  value,
  onChange,
  values = {},
  idPrefix = 'f',
  errors,
  builtIn,
  canAdvanced,
}: FieldProps) {
  const id = `${idPrefix}-${field.name}`;
  const error = errors?.[id];

  /** Renders a nested field (repeater items, section content) with this same renderer. */
  const renderField: RenderField = (sub, subValue, subChange, subPrefix, context) => (
    <Field
      key={sub.name}
      field={sub}
      value={subValue}
      onChange={subChange}
      idPrefix={subPrefix}
      errors={errors}
      canAdvanced={canAdvanced}
      {...(context?.values ? { values: context.values as Row } : {})}
      {...(context && 'builtIn' in context ? { builtIn: context.builtIn } : {})}
    />
  );
  const common = { field, value, onChange, idPrefix, errors, builtIn, values };

  // ── composite and referencing kinds ──────────────────────────────────────────
  if (field.kind === 'relation' || field.kind === 'multiRelation') {
    return (
      <RelationField
        field={field}
        value={value}
        onChange={onChange}
        idPrefix={idPrefix}
        errors={errors}
      />
    );
  }
  if (field.kind === 'media') return <MediaField {...common} />;
  if (field.kind === 'gallery') return <GalleryField {...common} />;
  if (field.kind === 'repeater') return <RepeaterField {...common} renderField={renderField} />;
  if (field.kind === 'object') {
    return (
      <ObjectField
        field={field}
        value={value}
        onChange={onChange}
        renderField={renderField}
        idPrefix={idPrefix}
        errors={errors}
      />
    );
  }
  if (field.kind === 'clip') {
    return (
      <ClipField
        field={field}
        value={value}
        onChange={onChange}
        idPrefix={idPrefix}
        errors={errors}
      />
    );
  }
  if (field.kind === 'sectionContent') {
    return (
      <SectionContentField
        field={field}
        value={value}
        sectionType={values[field.typeField ?? 'type']}
        onChange={onChange}
        renderField={renderField}
        idPrefix={idPrefix}
        errors={errors}
        builtIn={builtIn}
        canAdvanced={canAdvanced}
      />
    );
  }
  if (field.kind === 'upload') {
    return (
      <UploadField
        field={field}
        value={value}
        onChange={onChange}
        idPrefix={idPrefix}
        errors={errors}
      />
    );
  }

  // ── the field kit v2 (F5a) ───────────────────────────────────────────────────
  if (field.kind === 'bilingual' || field.kind === 'prose') return <BilingualField {...common} />;
  if (field.kind === 'checkbox') return <SwitchField {...common} />;
  if (field.kind === 'color') return <ColorField {...common} />;
  if (field.kind === 'range') return <RangeField {...common} />;
  if (field.kind === 'chips' || field.kind === 'tags') return <ChipsField {...common} />;

  // ── the rest of the kit (F5b) ────────────────────────────────────────────────
  if (field.kind === 'accent') return <AccentField {...common} />;
  if (field.kind === 'link') return <LinkField {...common} />;
  if (field.kind === 'slugRelation') return <SlugRelationField {...common} />;

  if (field.kind === 'richtext') return <RichTextField {...common} />;

  if (field.kind === 'multiSelect') {
    const chosen = Array.isArray(value) ? (value as string[]) : [];
    return (
      <FieldShell
        as="fieldset"
        id={id}
        label={field.label}
        required={field.required}
        meta={field.maxItems !== undefined ? `${chosen.length} of ${field.maxItems}` : undefined}
        hint={field.help}
        error={error}
      >
        <div className="row-3">
          {field.options?.map((option) => (
            <label key={option.value} className="field field-inline">
              <input
                type="checkbox"
                checked={chosen.includes(option.value)}
                onChange={(e) =>
                  onChange(
                    field.name,
                    e.target.checked
                      ? [...chosen, option.value]
                      : chosen.filter((v) => v !== option.value),
                  )
                }
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </FieldShell>
    );
  }

  const control = {
    id,
    'aria-required': field.required || undefined,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy(id, { hint: field.help, error }),
  };
  const shell = (children: ReactNode, meta?: string) => (
    <FieldShell
      id={id}
      label={field.label}
      required={field.required}
      meta={meta}
      hint={field.help}
      error={error}
    >
      {children}
    </FieldShell>
  );
  const counter = (text: string) =>
    field.maxLength !== undefined ? `${text.length}/${field.maxLength}` : undefined;

  if (field.kind === 'select') {
    return shell(
      <select
        {...control}
        value={String(value ?? '')}
        onChange={(e) => onChange(field.name, e.target.value)}
      >
        {/* An unset select means "leave it alone" (formPayload.ts). */}
        <option value="">Not set</option>
        {field.options?.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>,
    );
  }

  if (field.kind === 'json' || field.kind === 'textarea') {
    const text =
      field.kind === 'textarea'
        ? value === null || value === undefined
          ? ''
          : String(value)
        : typeof value === 'string'
          ? value
          : JSON.stringify(value ?? {}, null, 2);
    const json = field.kind === 'json';
    return shell(
      <textarea
        {...control}
        className={json ? 'in--mono' : undefined}
        value={text}
        maxLength={field.maxLength}
        onChange={(e) => onChange(field.name, e.target.value)}
        spellCheck={field.kind === 'textarea'}
      />,
      field.kind === 'textarea' ? counter(text) : undefined,
    );
  }

  const inputType =
    field.kind === 'number'
      ? 'number'
      : field.kind === 'url'
        ? 'url'
        : field.kind === 'datetime'
          ? 'datetime-local'
          : field.kind === 'date'
            ? 'date'
            : 'text';
  const text = value === null || value === undefined ? '' : String(value);
  // A list of bilingual phrases stores each as {en, ar} (ui/fields.ts bilingualList): the
  // `ar` box of an item is Arabic text.
  const arabic = field.name === 'ar';
  const narrow = inputType === 'number';

  return shell(
    <input
      {...control}
      type={inputType}
      lang={arabic ? 'ar' : undefined}
      dir={arabic ? 'rtl' : undefined}
      className={narrow ? NUMBER_CLASS : undefined}
      // EditorForm names a box the browser could not read by this (fieldErrors.ts).
      data-label={inputType === 'text' || inputType === 'url' ? undefined : field.label}
      value={text}
      maxLength={inputType === 'text' ? field.maxLength : undefined}
      onChange={(e) =>
        onChange(
          field.name,
          field.kind === 'number' ? numberOrNull(e.target.value) : e.target.value,
        )
      }
    />,
    inputType === 'text' ? counter(text) : undefined,
  );
}

/**
 * `richtext`: one Tiptap editor per language, the same halves as a bilingual field (the EN
 * | AR switch, Both side by side), the editor loaded lazily with a skeleton until it is in.
 * Its link button opens the kit's Modal (LinkDialog), passed in rather than imported by
 * RichText.tsx: a shared module RichText imported would be pulled into the lazy admin-rich
 * chunk, and every screen that uses it would then load the editor eagerly.
 */
function RichTextField({
  field,
  value,
  onChange,
  idPrefix,
  errors,
}: FieldProps & { idPrefix: string }) {
  const id = `${idPrefix}-${field.name}`;
  const ids = { en: `${id}-en`, ar: `${id}-ar` };
  const doc = (value ?? {}) as Record<string, TiptapDoc | undefined>;
  // E10: a body whose two languages go together counts an English with no Arabic as a gap.
  useArabicGap(ids.ar, richTextArabicGap(field.bothLanguages === true, value));
  const { shown, choose } = useFieldLanguage(ids);
  const readOnly = useContext(FieldsReadOnly);
  const both = shown === 'both';
  const half = (lang: 'en' | 'ar') => {
    const error = errors?.[ids[lang]];
    return (
      <div className="bi__half" hidden={!both && shown !== lang}>
        <p
          className={both ? 'bi__lang' : 'bi__lang visually-hidden'}
          lang={lang === 'ar' ? 'ar' : undefined}
        >
          {lang === 'en' ? 'English' : 'العربية'}
        </p>
        <Suspense fallback={<div className="rich rich--loading">Loading the editor…</div>}>
          <RichText
            id={ids[lang]}
            label={`${field.label} ${lang === 'en' ? 'English' : 'Arabic'}`}
            locale={lang}
            value={doc[lang] ?? null}
            onChange={(next) => onChange(field.name, { ...doc, [lang]: next })}
            invalid={Boolean(error)}
            describedBy={error ? `${ids[lang]}-error` : undefined}
            linkDialog={LinkDialog}
            readOnly={readOnly}
          />
        </Suspense>
        {error && (
          <p id={`${ids[lang]}-error`} className="field-error f__err">
            {error}
          </p>
        )}
      </div>
    );
  };
  return (
    <FieldShell
      as="fieldset"
      id={id}
      label={field.label}
      required={field.required}
      hint={field.help}
      error={errors?.[id]}
      labelExtra={
        !both && (
          <Segmented<'en' | 'ar'>
            label={`${field.label} language`}
            value={shown as 'en' | 'ar'}
            onChange={choose}
            options={[
              { value: 'en', label: 'English' },
              { value: 'ar', label: 'Arabic' },
            ]}
          />
        )
      }
    >
      <div className="bi" data-lang={shown}>
        {half('en')}
        {half('ar')}
      </div>
    </FieldShell>
  );
}

/** A number box is narrow (the prototype's max-width: 160px). */
const NUMBER_CLASS = 'in--num';

function numberOrNull(raw: string): number | null {
  if (raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// Pure payload shaping lives in src/lib/admin/formPayload.ts (unit-tested without a DOM);
// re-exported here because the forms import it from their field module.
export { rowToForm, formToPayload } from '@/lib/admin/formPayload';
