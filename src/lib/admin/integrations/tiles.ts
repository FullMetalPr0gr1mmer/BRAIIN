import type { IconName } from '@/lib/admin/icons';
import type { BadgeTone, NoteTone } from '@/lib/admin/tones';
import type { FieldDef } from '@/lib/admin/uiSchema';
import { CALENDLY_FIELD, GA4_FIELD, SEARCH_CONSOLE_FIELD } from '@/lib/admin/ui/integrations';
import type { IntegrationsView } from './view';

// The Integrations screen's tiles (Admin v2 U11, the prototype's settings/integrations grid,
// docs/admin-v2/ui.md AV-20): one per tool, each with its one typed field, or none for the
// captcha, which is not set up until its provider is chosen (owner item O-19). Copy follows
// P-12 (plain, no dashes, no brand) and says only what is true: a value nothing on the site
// uses yet is "Saved", never "Set up" or "Connected" (the prototype's fake "Connected" and
// "Test connection" are gone; deviations.md, Integrations).
//
// Google Analytics 4 (Admin v2 U15) follows the code-owned switch, GA4_NOTICE_READY
// (src/lib/http/ga4.ts): off (every production build until the owner signs off the privacy
// notice that names Google), a saved id loads nothing, and the tile and its drawer say why;
// on, the site loads it for visitors who accept analytics cookies, and the tile says Set up.
// The page reads the switch on the server and hands it to the island (`integrationTiles`).

export type IntegrationKey = 'ga4' | 'searchConsole' | 'calendly' | 'captcha';

export interface IntegrationNote {
  tone: NoteTone;
  text: string;
}

export interface IntegrationTile {
  key: IntegrationKey;
  name: string;
  icon: IconName;
  description: string;
  /** The one field its drawer edits, or null for a tile that is read-only. */
  field: FieldDef | null;
  /** The value's key in IntegrationsView, when it has one. */
  value: keyof IntegrationsView | null;
  /** True when the site uses a saved value now (the Search Console tag on the home pages). */
  live: boolean;
  /** What the drawer says under the field, always. */
  notes: readonly IntegrationNote[];
  /** What the drawer says once a value is saved. */
  saved?: IntegrationNote | undefined;
  /** What the tile itself says while a saved value is not used yet, and why. */
  waiting?: IntegrationNote | undefined;
}

/** The GA4 tile while the switch is off: saved, not loaded, and why. */
const GA4_HELD: IntegrationTile = {
  key: 'ga4',
  name: 'Google Analytics 4',
  icon: 'chart',
  description: 'Mirrors visits to Google Analytics. The built-in stats stay the main numbers.',
  value: 'ga4MeasurementId',
  live: false,
  field: GA4_FIELD,
  notes: [
    {
      tone: 'info',
      text: 'Saved only. The site does not load Google Analytics yet: first the privacy notice has to say that visit data goes to Google, and the site owner has to approve that wording. After that it loads only for visitors who accept analytics cookies.',
    },
  ],
  waiting: {
    tone: 'info',
    text: 'Not loading yet. It waits for the privacy notice to name Google, which the site owner approves.',
  },
};

/** The GA4 tile once the switch is on: the site loads it, behind analytics consent. */
const GA4_LIVE: IntegrationTile = {
  ...GA4_HELD,
  live: true,
  notes: [
    {
      tone: 'info',
      text: 'Loads only for visitors who accept analytics cookies. Nothing from Google loads before they do, and it stops when they say no.',
    },
  ],
  saved: {
    tone: 'ok',
    text: 'Visitors who accept analytics cookies now count in Google Analytics too. The built-in stats stay the main numbers.',
  },
  waiting: undefined,
};

/** The tiles as every production build shows them until the GA4 switch is on. */
export const INTEGRATION_TILES: readonly IntegrationTile[] = [
  GA4_HELD,
  {
    key: 'searchConsole',
    name: 'Google Search Console',
    icon: 'seo',
    description: 'Proves to Google that you own the site, so you can see how it does in search.',
    value: 'searchConsoleToken',
    live: true,
    field: SEARCH_CONSOLE_FIELD,
    notes: [
      {
        tone: 'warn',
        text: 'Whoever sets this can claim the site in Search Console and see its search data. Changes show in the activity log.',
      },
    ],
    saved: {
      tone: 'ok',
      text: 'The home page carries the tag now. Go back to Search Console and press Verify.',
    },
  },
  {
    key: 'calendly',
    name: 'Calendly',
    icon: 'cal',
    description: 'Your booking page, for a Book a call button.',
    value: 'calendlyUrl',
    live: false,
    field: CALENDLY_FIELD,
    notes: [{ tone: 'info', text: 'Saved for later. No page shows a booking button yet.' }],
  },
  {
    key: 'captcha',
    name: 'Captcha',
    icon: 'shield',
    description: 'An invisible check on the forms. The provider is not chosen yet.',
    value: null,
    live: false,
    field: null,
    notes: [
      {
        tone: 'info',
        text: 'Until then the forms are protected by a hidden field and rate limits.',
      },
    ],
  },
];

/** The tiles, with GA4 as the switch has it (`ga4Live`: GA4_NOTICE_READY on). */
export function integrationTiles(ga4Live: boolean): readonly IntegrationTile[] {
  return ga4Live
    ? INTEGRATION_TILES.map((tile) => (tile.key === 'ga4' ? GA4_LIVE : tile))
    : INTEGRATION_TILES;
}

export interface TileStatus {
  label: 'Set up' | 'Saved' | 'Not set up';
  tone: BadgeTone;
}

/** A tile's badge: Set up only when the site uses the value now; Saved when nothing does yet. */
export function tileStatus(tile: IntegrationTile, view: IntegrationsView): TileStatus {
  const value = tile.value ? view[tile.value] : null;
  if (!value) return { label: 'Not set up', tone: 'gray' };
  return tile.live ? { label: 'Set up', tone: 'ok' } : { label: 'Saved', tone: 'sky' };
}

/** The question Remove asks before it clears a setting. */
export function removeQuestion(tile: IntegrationTile): string {
  return `Remove the ${tile.name} setting? You can add it again any time.`;
}
