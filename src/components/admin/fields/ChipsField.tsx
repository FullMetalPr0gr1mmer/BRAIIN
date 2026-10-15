import { useState, type KeyboardEvent } from 'react';
import Icon from '@/components/admin/kit/Icon';
import Segmented from '@/components/admin/kit/Segmented';
import { cleanChips, splitChips } from '@/lib/admin/fieldValues';
import FieldShell from './FieldShell';
import { useFieldLanguage } from './editorLanguage';
import type { FieldComponentProps } from './types';

// `chips`, and `tags` drawn the same way (Admin v2 F5a, ui.md §2.6, the prototype's
// .tagsf): each phrase a chip with a "Remove tag <x>" button, and a text box where Enter or
// a comma adds what was typed (leaving the box does too, so nothing typed is lost to a
// Save). At `maxItems` the box is disabled and says "At most N". A chip longer than
// `chips.maxLength` is not added. `chips.bilingual` keeps two lists, {en: [], ar: []},
// shown like a bilingual field's halves (the EN | AR switch, Both side by side); the
// Arabic list is right to left.

type Lang = 'en' | 'ar';

interface ListProps {
  id: string;
  label: string;
  chips: readonly string[];
  onChange: (chips: string[]) => void;
  max: number | undefined;
  maxLength: number | undefined;
  lang?: Lang | undefined;
  describedBy?: string | undefined;
  /** The group's label plus the language's, for a bilingual set's box. */
  labelledBy?: string | undefined;
  invalid: boolean;
}

function ChipList({
  id,
  label,
  chips,
  onChange,
  max,
  maxLength,
  lang,
  describedBy,
  labelledBy,
  invalid,
}: ListProps) {
  const [draft, setDraft] = useState('');
  const full = max !== undefined && chips.length >= max;

  function add(words: readonly string[]) {
    const fitting = words.filter((w) => maxLength === undefined || w.length <= maxLength);
    const next = cleanChips([...chips, ...fitting]);
    onChange(max === undefined ? next : next.slice(0, max));
  }

  function commit(text: string) {
    const word = text.trim();
    if (word !== '') add([word]);
    setDraft('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      // The box sits inside the edit <form>: Enter adds a chip, it never submits.
      event.preventDefault();
      commit(draft);
    } else if (event.key === 'Backspace' && draft === '' && chips.length > 0) {
      onChange(chips.slice(0, -1));
    }
  }

  return (
    <div className="tagsf" dir={lang === 'ar' ? 'rtl' : undefined}>
      {chips.length > 0 && (
        <ul className="tagsf__list" aria-label={label}>
          {chips.map((chip) => (
            <li key={chip} className="tg" lang={lang}>
              <span>{chip}</span>
              <button
                type="button"
                className="tg__x"
                aria-label={`Remove tag ${chip}`}
                onClick={() => onChange(chips.filter((c) => c !== chip))}
              >
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        id={id}
        type="text"
        lang={lang}
        dir={lang === 'ar' ? 'rtl' : undefined}
        value={draft}
        disabled={full}
        placeholder={full ? `At most ${max}` : 'Type, then press Enter'}
        maxLength={maxLength}
        aria-describedby={describedBy}
        aria-labelledby={labelledBy}
        aria-invalid={invalid || undefined}
        onKeyDown={onKeyDown}
        onBlur={() => commit(draft)}
        onChange={(e) => {
          const { chips: done, rest } = splitChips(e.target.value);
          if (done.length > 0) add(done);
          setDraft(rest);
        }}
      />
    </div>
  );
}

export default function ChipsField({
  field,
  value,
  onChange,
  idPrefix,
  errors,
}: FieldComponentProps) {
  const id = `${idPrefix}-${field.name}`;
  const bilingual = field.chips?.bilingual === true;
  const ids: Record<Lang, string> = { en: `${id}-en`, ar: `${id}-ar` };
  const { shown, choose } = useFieldLanguage(ids);
  const maxLength = field.chips?.maxLength;
  const max = field.maxItems;
  const hintId = `${id}-hint`;
  const count = (n: number) => (max !== undefined ? `${n} of ${max}` : undefined);
  const atMost = (n: number) => (max !== undefined && n >= max ? `At most ${max}.` : null);

  if (!bilingual) {
    const chips = cleanChips(value);
    const error = errors?.[id];
    const hint = [field.help, atMost(chips.length)].filter(Boolean).join(' ') || undefined;
    return (
      <FieldShell
        id={id}
        label={field.label}
        required={field.required}
        meta={count(chips.length)}
        hint={hint}
        error={error}
      >
        <ChipList
          id={id}
          label={field.label}
          chips={chips}
          onChange={(next) => onChange(field.name, next)}
          max={max}
          maxLength={maxLength}
          describedBy={
            [hint ? hintId : null, error ? `${id}-error` : null].filter(Boolean).join(' ') ||
            undefined
          }
          invalid={Boolean(error)}
        />
      </FieldShell>
    );
  }

  const pair = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const lists: Record<Lang, string[]> = { en: cleanChips(pair['en']), ar: cleanChips(pair['ar']) };
  const both = shown === 'both';
  const hint = field.help;
  const half = (lang: Lang) => {
    const error = errors?.[ids[lang]];
    return (
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
          {both && count(lists[lang].length) && (
            <span className="f__meta">{count(lists[lang].length)}</span>
          )}
        </div>
        <ChipList
          id={ids[lang]}
          label={`${field.label} (${lang === 'en' ? 'English' : 'Arabic'})`}
          chips={lists[lang]}
          onChange={(next) => onChange(field.name, { ...lists, [lang]: next })}
          max={max}
          maxLength={maxLength}
          lang={lang}
          labelledBy={`${id}-legend ${ids[lang]}-lang`}
          describedBy={
            [hint ? hintId : null, error ? `${ids[lang]}-error` : null].filter(Boolean).join(' ') ||
            undefined
          }
          invalid={Boolean(error)}
        />
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
      meta={both ? undefined : count(lists[shown as Lang].length)}
      hint={hint}
      error={errors?.[id]}
      legendId={`${id}-legend`}
      labelExtra={
        !both && (
          <Segmented<Lang>
            label={`${field.label} language`}
            value={shown as Lang}
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
