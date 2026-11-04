import { INTRO_COLUMNS, INTRO_FADE, INTRO_HOLD, INTRO_TAGLINE_MAX } from '@schemas/appearance';
import type { SingletonUi } from './types';

// The loading screen's look, `site_appearance`'s intro_ columns (Admin v2 E7,
// /admin/appearance/loading, the prototype's `route('/appearance/loading')`): the Style card
// (what is behind the logo, drawn by the screen as tiles over `backdrop`; the bar; the tagline)
// and the Timing card (the hold and the fade, in the buckets the site's CSS maps), every option
// a closed set (packages/schemas/appearance.ts) so the intro stays inside what its CSS and its
// budgets were built for. The same endpoint as the Header screen: each screen sends only its
// own keys. Whether the intro shows at all is the home hero's switch, not this row (P-9), and
// the preview and the facts are the screen's own (src/components/admin/screens/loading/).
//
// Copy rules (P-12): plain, warm, no em or en dash, the brand never spelled.

/** The tiles' labels, one per backdrop (the screen draws the tiles, the release words read them). */
export const BACKDROP_LABELS = {
  video: 'Logo over the video',
  black: 'Logo on black',
  light: 'Logo on light',
} as const;

export const loadingUi: SingletonUi = {
  endpoint: '/api/admin/site-appearance',
  title: 'Loading screen',
  fields: [
    {
      name: 'backdrop',
      label: 'Style',
      kind: 'select',
      column: INTRO_COLUMNS.backdrop,
      required: true,
      options: [
        { value: 'video', label: BACKDROP_LABELS.video },
        { value: 'black', label: BACKDROP_LABELS.black },
        { value: 'light', label: BACKDROP_LABELS.light },
      ],
    },
    {
      name: 'bar',
      label: 'Progress bar',
      kind: 'checkbox',
      column: INTRO_COLUMNS.bar,
      help: 'A thin bar under the logo fills while it holds.',
    },
    {
      name: 'tagline',
      label: 'Tagline under the logo',
      kind: 'bilingual',
      column: INTRO_COLUMNS.tagline,
      nullable: true,
      maxLength: INTRO_TAGLINE_MAX,
      help: 'Optional. A short line in both languages; leave both empty for none.',
    },
    {
      name: 'holdMs',
      label: 'Duration',
      kind: 'range',
      column: INTRO_COLUMNS.holdMs,
      required: true,
      defaultValue: 1000,
      range: { min: INTRO_HOLD.min, max: INTRO_HOLD.max, step: INTRO_HOLD.step, suffix: ' ms' },
      help: 'How long the logo holds. The site rule: never longer than 1.5 s.',
    },
    {
      name: 'fadeMs',
      label: 'Fade',
      kind: 'range',
      column: INTRO_COLUMNS.fadeMs,
      required: true,
      defaultValue: 450,
      range: { min: INTRO_FADE.min, max: INTRO_FADE.max, step: INTRO_FADE.step, suffix: ' ms' },
      help: 'How long the intro takes to leave. The headline follows on its own.',
    },
  ],
  groups: [
    // The Style card's tiles are the screen's (a radio group over `backdrop`), above its fields.
    { id: 'style', title: 'Style', column: 'left', fields: ['bar', 'tagline'] },
    { id: 'timing', title: 'Timing', column: 'left', fields: ['holdMs', 'fadeMs'] },
    { id: 'preview', title: 'Preview', column: 'right', fields: [] },
    { id: 'facts', title: 'Always true', column: 'right', fields: [] },
  ],
};
