import { useEffect, useState } from 'react';
import Segmented from '@/components/admin/kit/Segmented';
import { adminFetch, describeError } from '@/lib/admin/client';
import { linkHrefOk, linkState, type LinkFormState } from '@/lib/admin/formPayload';
import type { Linkable } from '@/lib/admin/linkables';
import FieldShell, { describedBy } from './FieldShell';
import { useFieldLanguage } from './editorLanguage';
import type { FieldComponentProps } from './types';

// `link` (Admin v2 F5b, ui.md §2.6): a button or a text link — `{label: {en, ar}, href}`.
//
// The target is picked from the pages this site HAS (GET /api/admin/linkables: the code
// routes, the published pages' own titles, every published service and project), so the
// usual way to make a link cannot make a broken one. The picker WRITES INTO the box
// beside it rather than replacing it: the box is always the value, so a target the list
// does not have (an anchor, a page since unpublished) is visible rather than hidden
// behind "nothing chosen", and a server render shows the same thing as a hydrated one.
// What the box accepts is the rule the server enforces (SafeHrefSchema, or https where
// the field says the schema takes one — decision D3); the server validates every save.
//
// Choosing a target fills both labels when they are empty, so the common case is one
// choice and no typing. An editor who then writes their own words keeps them.

const GROUP_NAMES: Record<Linkable['group'], string> = {
  page: 'Pages',
  service: 'Services',
  project: 'Projects',
  legal: 'Legal',
  anchor: 'Places on a page',
};
const GROUP_ORDER: readonly Linkable['group'][] = ['page', 'service', 'project', 'anchor', 'legal'];

/**
 * The link targets, asked for when the picker is first reached — not on mount. A form may
 * hold several link fields and a screen that only reads one never spends a subrequest on
 * them (the Worker's Free plan allows 50); and the component kit's reference screen, which
 * reads nothing, stays that way for every role.
 */
function useLinkables(): {
  links: Linkable[];
  error: string;
  loading: boolean;
  ask: () => void;
} {
  const [links, setLinks] = useState<Linkable[]>([]);
  const [error, setError] = useState('');
  const [asked, setAsked] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!asked) return;
    const controller = new AbortController();
    setLoading(true);
    adminFetch<{ links: Linkable[] }>('/api/admin/linkables', { signal: controller.signal })
      .then((answer) => setLinks(answer.links ?? []))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(describeError(err));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [asked]);
  return { links, error, loading, ask: () => setAsked(true) };
}

type Lang = 'en' | 'ar';
const LANGUAGE_NAME: Record<Lang, string> = { en: 'English', ar: 'Arabic' };

export default function LinkField({
  field,
  value,
  onChange,
  idPrefix,
  errors,
}: FieldComponentProps) {
  const id = `${idPrefix}-${field.name}`;
  const ids: Record<Lang, string> = { en: `${id}-label-en`, ar: `${id}-label-ar` };
  const hrefId = `${id}-href`;
  const { links, error: loadError, loading, ask } = useLinkables();
  const { shown, choose } = useFieldLanguage(ids);
  const both = shown === 'both';
  const link = linkState(value);

  const known = links.find((target) => target.href === link.href);
  const hrefError = errors?.[hrefId];
  const hrefBad = link.href !== '' && !linkHrefOk(link.href, field);

  const set = (patch: Partial<LinkFormState>) => onChange(field.name, { ...link, ...patch });
  const setLabel = (lang: Lang, text: string) => set({ label: { ...link.label, [lang]: text } });

  /** Picking a target fills empty labels with its name, and never overwrites words. */
  const pick = (href: string) => {
    const target = links.find((item) => item.href === href);
    const blank = link.label.en.trim() === '' && link.label.ar.trim() === '';
    set({
      href,
      ...(target && blank ? { label: { en: target.label.en, ar: target.label.ar } } : {}),
    });
  };

  const labelInput = (lang: Lang) => {
    const error = errors?.[ids[lang]];
    const arabic = lang === 'ar';
    return (
      <div className="bi__half" hidden={!both && shown !== lang}>
        <div className="bi__h">
          <label
            htmlFor={ids[lang]}
            id={`${ids[lang]}-lang`}
            className={both ? 'bi__lang' : 'bi__lang visually-hidden'}
            lang={arabic ? 'ar' : undefined}
          >
            {arabic ? 'العربية' : 'English'}
          </label>
        </div>
        <input
          type="text"
          id={ids[lang]}
          lang={lang}
          dir={arabic ? 'rtl' : undefined}
          value={link.label[lang]}
          maxLength={field.maxLength}
          aria-labelledby={`${id}-label-legend ${ids[lang]}-lang`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${ids[lang]}-error` : undefined}
          onChange={(e) => setLabel(lang, e.target.value)}
        />
        {error && (
          <p id={`${ids[lang]}-error`} className="field-error f__err">
            {LANGUAGE_NAME[lang]}: {error}
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
      legendId={`${id}-legend`}
    >
      <div className="linkf">
        <div className="f">
          <div className="f__l">
            <span id={`${id}-label-legend`}>Words on the link</span>
            {!both && (
              <Segmented<Lang>
                label={`${field.label} language`}
                value={shown as Lang}
                onChange={choose}
                options={[
                  { value: 'en', label: 'English' },
                  { value: 'ar', label: 'Arabic' },
                ]}
              />
            )}
          </div>
          <div className="bi" data-lang={shown}>
            {labelInput('en')}
            {labelInput('ar')}
          </div>
        </div>

        <div className="f">
          <div className="f__l">
            <label htmlFor={hrefId}>Where it goes</label>
          </div>
          <div className="linkf__where">
            {/* The picker writes into the box; the box is always the value, so an editor
                always sees where the link goes and a target the list does not have (an
                anchor, a page since unpublished) is never hidden behind "nothing
                chosen". An explicit choice, never a side effect of arrowing through a
                closed select (WCAG F37): picking is the change, and it writes once. */}
            <select
              id={`${id}-target`}
              aria-label={`${field.label}: pick a page`}
              value={known ? link.href : ''}
              onFocus={ask}
              onPointerDown={ask}
              onChange={(e) => {
                if (e.target.value !== '') pick(e.target.value);
              }}
            >
              <option value="">{loading ? 'Loading the pages…' : 'Pick a page…'}</option>
              {GROUP_ORDER.filter((group) => links.some((item) => item.group === group)).map(
                (group) => (
                  <optgroup key={group} label={GROUP_NAMES[group]}>
                    {links
                      .filter((item) => item.group === group)
                      .map((item) => (
                        <option key={item.href} value={item.href}>
                          {item.label.en} ({item.href})
                        </option>
                      ))}
                  </optgroup>
                ),
              )}
            </select>
            <input
              type="text"
              id={hrefId}
              className="in--mono"
              spellCheck={false}
              autoComplete="off"
              placeholder={field.link?.external ? 'https://… or /about' : '/about or #inquiry'}
              value={link.href}
              aria-invalid={hrefError || hrefBad ? true : undefined}
              aria-describedby={describedBy(hrefId, {
                hint: true,
                error: hrefError || hrefBad,
              })}
              onChange={(e) => set({ href: e.target.value })}
            />
          </div>
          {hrefError && (
            <p id={`${hrefId}-error`} className="field-error f__err">
              {hrefError}
            </p>
          )}
          {!hrefError && hrefBad && (
            <p id={`${hrefId}-error`} className="field-error f__err">
              {field.link?.external
                ? 'Use a page of this site (/about), a place on one (#inquiry), or an https address.'
                : 'Use a page of this site (/about) or a place on one (#inquiry).'}
            </p>
          )}
          <p id={`${hrefId}-hint`} className="f__hint">
            Pick a page, or write where it goes: a page of this site starts with “/”, a place on the
            page it is on starts with “#”.
          </p>
          {/* A role that may not read the list (SEO: §5 gives it no field holding a link)
              is not an error on this screen — the box still works, so this is a note. */}
          {loadError && <p className="f__hint">The page list is not available here. {loadError}</p>}
        </div>
      </div>
    </FieldShell>
  );
}
