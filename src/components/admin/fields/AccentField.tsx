import Segmented from '@/components/admin/kit/Segmented';
import { accentPreview, accentWords } from '@/lib/admin/accentWords';
import { accentState, type AccentFormState } from '@/lib/admin/formPayload';
import FieldShell from './FieldShell';
import { useFieldLanguage } from './editorLanguage';
import type { FieldComponentProps } from './types';

// `accent` (Admin v2 F5b, ui.md §2.6): which WORDS of a sibling heading carry the Klein
// blue. The mockup highlighted them with an "Aa" button that wrote HTML into the copy;
// this writes a word range and nothing else (Pillar 1: no stored markup, ever), and the
// server renders the runs.
//
// The words are the public renderer's own (src/lib/text/accent.ts through
// src/lib/admin/accentWords.ts), so "from word 3" means the same word here and on the
// page. Two ways of storing the same choice, both drawn the same way:
//   mode 'range'  a range per language, its own content key (AccentSchema);
//   mode 'from'   "from word N to the end", the two numbers beside the heading (the hero
//                 and the slogan band: accentFromEn / accentFromAr).
//
// A stored range is held inside the words that are left (formPayload's accentToRanges),
// so shortening a heading can never leave a range pointing past its end.

type Lang = 'en' | 'ar';
const LANGUAGE_NAME: Record<Lang, string> = { en: 'English', ar: 'Arabic' };

/** `['Ideas', 'that']` → the options of a word picker, counted from 1 for a reader. */
function wordOptions(words: readonly string[], from: number): { value: number; label: string }[] {
  return words.slice(from).map((word, index) => ({
    value: from + index,
    label: `${from + index + 1}. ${word}`,
  }));
}

export default function AccentField({
  field,
  value,
  onChange,
  idPrefix,
  errors,
  values,
}: FieldComponentProps) {
  const id = `${idPrefix}-${field.name}`;
  const ids: Record<Lang, string> = { en: `${id}-en`, ar: `${id}-ar` };
  const { shown, choose } = useFieldLanguage(ids);
  const both = shown === 'both';
  const state = accentState(value);
  const def = field.accent;
  const sibling = (values?.[def?.of ?? ''] ?? {}) as Record<string, unknown>;

  const set = (lang: Lang, patch: Partial<AccentFormState['en']>) =>
    onChange(field.name, { ...state, [lang]: { ...state[lang], ...patch } });

  const half = (lang: Lang) => {
    const text = typeof sibling[lang] === 'string' ? (sibling[lang] as string) : '';
    const words = accentWords(text);
    const range = state[lang];
    const from = range.from;
    const preview = accentPreview(
      text,
      from === null ? undefined : { from, ...(range.to === null ? {} : { to: range.to }) },
    );
    const fromId = `${ids[lang]}-from`;
    const toId = `${ids[lang]}-to`;
    const fromError = errors?.[fromId];
    const toError = errors?.[toId];
    const arabic = lang === 'ar';

    return (
      <div className="bi__half" hidden={!both && shown !== lang}>
        <p
          className={both ? 'bi__lang' : 'bi__lang visually-hidden'}
          lang={arabic ? 'ar' : undefined}
        >
          {arabic ? 'العربية' : 'English'}
        </p>
        {words.length === 0 ? (
          <p className="f__cue">
            Write the {LANGUAGE_NAME[lang]} words first, then choose which of them carry the colour.
          </p>
        ) : (
          <div className="accentf">
            <label className="accentf__pick" htmlFor={fromId}>
              <span>Highlight from</span>
              <select
                id={fromId}
                lang={arabic ? 'ar' : undefined}
                dir={arabic ? 'rtl' : undefined}
                value={from === null ? '' : String(from)}
                aria-invalid={fromError ? true : undefined}
                onChange={(e) => {
                  if (e.target.value === '') return set(lang, { from: null, to: null });
                  const next = Number(e.target.value);
                  // The end keeps its word while it is still after the new start.
                  set(lang, {
                    from: next,
                    to: range.to !== null && range.to > next ? range.to : null,
                  });
                }}
              >
                <option value="">No highlight</option>
                {wordOptions(words, 0).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {def?.mode === 'range' && from !== null && (
              <label className="accentf__pick" htmlFor={toId}>
                <span>up to</span>
                <select
                  id={toId}
                  lang={arabic ? 'ar' : undefined}
                  dir={arabic ? 'rtl' : undefined}
                  value={range.to === null ? '' : String(range.to)}
                  aria-invalid={toError ? true : undefined}
                  onChange={(e) =>
                    set(lang, { to: e.target.value === '' ? null : Number(e.target.value) })
                  }
                >
                  <option value="">the last word</option>
                  {/* `to` is exclusive: the option for word N ends the highlight after it. */}
                  {wordOptions(words, from).map((option) => (
                    <option key={option.value} value={option.value + 1}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        {words.length > 0 && (
          <p
            className="accentf__preview"
            lang={arabic ? 'ar' : undefined}
            dir={arabic ? 'rtl' : undefined}
          >
            {preview.accented ? (
              <>
                {preview.before ? `${preview.before} ` : ''}
                <mark className="accentf__on">{preview.accented}</mark>
                {preview.after ? ` ${preview.after}` : ''}
              </>
            ) : (
              preview.before
            )}
          </p>
        )}
        {[fromError, toError].map((message, index) =>
          message ? (
            <p key={index} className="field-error f__err">
              {LANGUAGE_NAME[lang]}: {message}
            </p>
          ) : null,
        )}
      </div>
    );
  };

  const toggle = !both && (
    <Segmented<Lang>
      label={`${field.label} language`}
      value={shown as Lang}
      onChange={choose}
      options={[
        { value: 'en', label: 'English' },
        { value: 'ar', label: 'Arabic' },
      ]}
    />
  );

  return (
    <FieldShell
      as="fieldset"
      id={id}
      label={field.label}
      hint={
        field.help ??
        (def?.mode === 'from'
          ? 'The colour runs from the word you choose to the end of the line.'
          : 'The words you choose are shown in the brand colour. Nothing else changes.')
      }
      error={errors?.[id]}
      legendId={`${id}-legend`}
      labelExtra={toggle}
    >
      <div className="bi" data-lang={shown}>
        {half('en')}
        {half('ar')}
      </div>
    </FieldShell>
  );
}
