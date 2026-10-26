// What a project needs before it can go live (Admin v2 U6, AV-15: "a publish-requirements
// panel mirrors assertPublishable"), as the editor's Publishing tab lists it. The server stays
// the gate (resources/portfolio.ts assertPublishable, and the 0025 placeholder guard in
// production): this is the same list, said in advance, so a refused publish is never the
// first time an editor hears of a rule. tests/lib/projectEditor.spec.ts runs both over the
// same rows and holds them equal. Pure.

export interface Requirement {
  id: 'title' | 'type' | 'poster' | 'alt' | 'sample' | 'figures';
  label: string;
  met: boolean;
}

type Row = Readonly<Record<string, unknown>>;

const has = (value: unknown, lang: 'en' | 'ar'): boolean => {
  if (!value || typeof value !== 'object') return false;
  const text = (value as Row)[lang];
  return typeof text === 'string' && text.trim() !== '';
};

const both = (value: unknown): boolean => has(value, 'en') && has(value, 'ar');

/** A result figure still showing the design's placeholder (resources/shared.ts: /X{2,}/i). */
export function placeholderFigure(results: unknown): boolean {
  const items = Array.isArray(results) ? (results as Row[]) : [];
  return items.some((r) => /X{2,}/i.test(String(r['value'] ?? '')));
}

/**
 * The requirements over the editor's values (camelCase, as the form holds them) and the
 * poster's row as the library answers it (null while unread or with no poster; `alt` is its
 * text in both languages).
 */
export function publishRequirements(values: Row, poster: Row | null): Requirement[] {
  const posterId = typeof values['posterMediaId'] === 'string' ? values['posterMediaId'] : '';
  return [
    { id: 'title', label: 'The name in English and Arabic', met: both(values['title']) },
    { id: 'type', label: 'The type in English and Arabic', met: both(values['projectType']) },
    { id: 'poster', label: 'A poster (the card image)', met: posterId !== '' },
    {
      id: 'alt',
      label: 'The poster’s alt text in English and Arabic (in the media library)',
      met: posterId !== '' && poster !== null && both(poster['alt']),
    },
    {
      id: 'sample',
      label: 'Not a design sample (Placeholder switched off)',
      met: values['isPlaceholder'] !== true,
    },
    {
      id: 'figures',
      label: 'No placeholder figure (XX) in the result numbers',
      met: !placeholderFigure(values['results']),
    },
  ];
}

/** "Ready to publish." or "2 things to do before it can be published." */
export function requirementsSummary(requirements: readonly Requirement[]): string {
  const left = requirements.filter((r) => !r.met).length;
  if (left === 0) return 'Ready to publish.';
  return left === 1
    ? '1 thing to do before it can be published.'
    : `${left} things to do before it can be published.`;
}
