import { PUBLIC_SITE_URL } from 'astro:env/client';
import { applyTitleTemplate } from '@/lib/seo/title';
import type { Bi } from './types';

// The search result a page would make, in English and in Arabic (Admin v2 U10, ui.md AV-19,
// the prototype's seoDrawer preview): the title through the site's title template with the
// brand, the address on the site's own origin, and the description, or the prototype's nudge
// when there is none. An empty box shows the page's default, as the public head would. Plain
// text nodes only, in the admin's own tokens (D15): an impression of a result, not a copy of
// Google's page.

export const NO_DESCRIPTION = 'Add a description so Google shows your words instead of guessing.';

export interface PreviewInput {
  lang: 'en' | 'ar';
  /** What the editor typed (blank keeps the default). */
  title: string;
  description: string;
  /** The page's own words when the boxes are blank. */
  defaults: { title: string; description: string };
  brand: string;
  template: string;
  /** The page's logical path (`/services/logo`), or null for a page no route renders. */
  path: string | null;
  origin?: string;
}

export interface Preview {
  title: string;
  url: string;
  description: string;
  /** The description is the nudge, not words of the page's own. */
  empty: boolean;
}

/** One language's result. */
export function previewOf(input: PreviewInput): Preview {
  const origin = (input.origin ?? PUBLIC_SITE_URL).replace(/\/+$/, '');
  let host = origin;
  try {
    host = new URL(origin).host;
  } catch {
    // An unparsable origin is shown as it is.
  }
  const logical = input.path ?? '/';
  const path = input.lang === 'ar' ? (logical === '/' ? '/ar' : `/ar${logical}`) : logical;
  const segments = path.split('/').filter(Boolean);
  const raw = input.title.trim() || input.defaults.title;
  const description = (input.description.trim() || input.defaults.description).replace(
    /%brand%/g,
    () => input.brand,
  );
  return {
    title: applyTitleTemplate(input.template, raw, input.brand),
    url: [host, ...segments].join(' › '),
    description: description || NO_DESCRIPTION,
    empty: !description,
  };
}

export interface GooglePreviewProps {
  title: Bi;
  description: Bi;
  defaults: { title: Bi; description: Bi };
  brand: Bi;
  template: Bi;
  path: string | null;
}

export default function GooglePreview({
  title,
  description,
  defaults,
  brand,
  template,
  path,
}: GooglePreviewProps) {
  const one = (lang: 'en' | 'ar') =>
    previewOf({
      lang,
      title: title[lang],
      description: description[lang],
      defaults: { title: defaults.title[lang], description: defaults.description[lang] },
      brand: brand[lang],
      template: template[lang],
      path,
    });
  return (
    <div className="seo-previews">
      {(['en', 'ar'] as const).map((lang) => {
        const result = one(lang);
        const heading = lang === 'en' ? 'Google preview' : 'Google preview in Arabic';
        return (
          <section key={lang} className="seo-preview" aria-label={heading}>
            <p className="seo-preview__h">{heading}</p>
            <div className="seo-preview__card" lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
              <p className="seo-preview__url" dir="ltr">
                {result.url}
              </p>
              <p className="seo-preview__title">{result.title}</p>
              <p className="seo-preview__desc" data-empty={result.empty ? '' : undefined}>
                {result.empty && lang === 'ar' ? (
                  <span lang="en" dir="ltr">
                    {result.description}
                  </span>
                ) : (
                  result.description
                )}
              </p>
            </div>
          </section>
        );
      })}
    </div>
  );
}
