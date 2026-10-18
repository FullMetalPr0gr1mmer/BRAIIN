import Segmented from '@/components/admin/kit/Segmented';
import FieldShell from './FieldShell';
import { useArabicGap, useFieldLanguage } from './editorLanguage';
import type { FieldComponentProps } from './types';

// `bilingual` ({en, ar}, both required) and `prose` ({en, ar?}, multiline, the Arabic may
// lag translation), Admin v2 F5a (ui.md §2.6). Both inputs stay in the DOM and the one not
// shown is `hidden`, so its value, its error and its "missing" cue stay reachable; the
// EN | AR switch in the label row picks the half (a kit Segmented: native radios named
// "<Label> language"), and the editor's English / العربية / Both switch sets every field
// at once (editorLanguage.tsx). In Both the halves sit side by side, each with its label.
//
// The Arabic half is `lang="ar" dir="rtl"`, in Almarai (admin.css), so an author sees the
// reading order and the face visitors do. Its digits are never touched: the value is the
// input's, as typed (P-12; tests/lib/arabicDigits.spec.ts).
//
// "Arabic (missing)": a `bilingual` pair is required in both languages when it is
// required, or once its English is written (the server refuses a half pair), so an empty
// Arabic half then names the AR option "Arabic (missing)" with a warn dot, and counts in
// the form's "Arabic missing: N" bar. `prose` lets the Arabic lag: a neutral line says
// "Arabic not written yet".
//
// `multiline` (Admin v2 U7, D14): a `bilingual` pair written as a paragraph (an FAQ answer,
// a quote) takes a five-row textarea per language and stays required in both, unlike
// `prose`. Unset, the field renders exactly as before.

type Lang = 'en' | 'ar';
const LANGUAGE_NAME: Record<Lang, string> = { en: 'English', ar: 'Arabic' };

export default function BilingualField({
  field,
  value,
  onChange,
  idPrefix,
  errors,
  builtIn,
}: FieldComponentProps) {
  const id = `${idPrefix}-${field.name}`;
  const ids: Record<Lang, string> = { en: `${id}-en`, ar: `${id}-ar` };
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const text: Record<Lang, string> = {
    en: typeof record['en'] === 'string' ? record['en'] : '',
    ar: typeof record['ar'] === 'string' ? record['ar'] : '',
  };
  const multiline =
    field.kind === 'prose' || (field.kind === 'bilingual' && field.multiline === true);
  const rows = field.kind === 'bilingual' && field.multiline === true ? 5 : undefined;
  const english = text.en.trim() !== '';
  const arabicEmpty = text.ar.trim() === '';
  const arabicRequired = field.kind === 'bilingual' && (field.required === true || english);
  const missing = arabicRequired && arabicEmpty;
  const lagging = field.kind === 'prose' && english && arabicEmpty;
  // The stale-translation note (F5b, ui.md §2.6): the English has been written over the
  // built-in copy while the Arabic is still the built-in's own words, so a visitor reading
  // Arabic sees the old line. Only where a built-in is known (section content).
  const defaults = (builtIn && typeof builtIn === 'object' ? builtIn : {}) as Record<
    string,
    unknown
  >;
  const stale =
    typeof defaults['en'] === 'string' &&
    typeof defaults['ar'] === 'string' &&
    text.en.trim() !== '' &&
    text.en !== defaults['en'] &&
    text.ar === defaults['ar'];

  useArabicGap(ids.ar, missing);
  const { shown, choose } = useFieldLanguage(ids);
  const both = shown === 'both';
  const counter = (lang: Lang) =>
    field.maxLength ? `${text[lang].length}/${field.maxLength}` : undefined;

  const input = (lang: Lang) => {
    const error = errors?.[ids[lang]];
    const props = {
      id: ids[lang],
      lang,
      dir: lang === 'ar' ? 'rtl' : undefined,
      value: text[lang],
      maxLength: field.maxLength,
      'aria-required':
        (lang === 'en' ? field.required === true : arabicRequired && field.required === true) ||
        undefined,
      'aria-invalid': error ? true : undefined,
      'aria-labelledby': `${id}-legend ${ids[lang]}-lang`,
      'aria-describedby':
        [field.help ? `${id}-hint` : null, error ? `${ids[lang]}-error` : null]
          .filter(Boolean)
          .join(' ') || undefined,
      onChange: (e: { target: { value: string } }) =>
        onChange(field.name, { ...record, [lang]: e.target.value }),
    };
    return multiline ? <textarea rows={rows} {...props} /> : <input type="text" {...props} />;
  };

  const half = (lang: Lang) => (
    <div className="bi__half" hidden={!both && shown !== lang}>
      <div className="bi__h">
        <label
          htmlFor={ids[lang]}
          id={`${ids[lang]}-lang`}
          className={both ? 'bi__lang' : 'bi__lang visually-hidden'}
          lang={lang === 'ar' ? 'ar' : undefined}
        >
          {lang === 'en' ? 'English' : 'العربية'}
        </label>
        {both && counter(lang) && <span className="f__meta">{counter(lang)}</span>}
      </div>
      {input(lang)}
    </div>
  );

  const toggle = !both && (
    <Segmented<Lang>
      label={`${field.label} language`}
      value={shown as Lang}
      onChange={choose}
      options={[
        { value: 'en', label: 'English' },
        { value: 'ar', label: 'Arabic', cue: missing ? ' (missing)' : undefined },
      ]}
    />
  );

  return (
    <FieldShell
      as="fieldset"
      id={id}
      label={field.label}
      required={field.required}
      meta={both ? undefined : counter(shown as Lang)}
      hint={field.help}
      error={errors?.[id]}
      legendId={`${id}-legend`}
      labelExtra={toggle}
    >
      <div className="bi" data-lang={shown}>
        {half('en')}
        {half('ar')}
      </div>
      {lagging && <p className="f__cue">Arabic not written yet</p>}
      {stale && <p className="f__cue">Arabic still shows the built-in text.</p>}
      {(['en', 'ar'] as const).map((lang) => {
        const error = errors?.[ids[lang]];
        return error ? (
          <p key={lang} id={`${ids[lang]}-error`} className="field-error f__err">
            {LANGUAGE_NAME[lang]}: {error}
          </p>
        ) : null;
      })}
    </FieldShell>
  );
}
