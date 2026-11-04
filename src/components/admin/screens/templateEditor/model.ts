import { TEMPLATE_COPY_KEYS, type TemplateKind } from '@schemas/templateCopyKeys';
import type { FieldDef } from '@/lib/admin/uiSchema';
import { portfolioUi } from '@/lib/admin/ui/portfolio';
import { servicesUi } from '@/lib/admin/ui/services';
import { TEMPLATE_PARTS } from '@/lib/templates/parts';
import type { TemplateItem, TemplateItemGroup } from './types';

// The template editors' pure model (Admin v2 E3): which of the item's own fields the "This
// service" / "This project" group draws (the full editor's own field definitions, so the save
// is the full editor's: the same target, the same fields, the same schema), the shared text's
// one form field (an object of the template's catalogue keys, drawn in one group per part of
// the page), and the small decisions the screen makes. Zod-free and client-safe: the island
// imports it. tests/lib/templateEditor.spec.ts holds it to the catalogue and the parts.

type Row = Record<string, unknown>;

/** The words of the item a template page shows, in the full editor's field order. */
export const ITEM_FIELD_NAMES: Readonly<Record<TemplateKind, readonly string[]>> = {
  service: ['title', 'blurb', 'intro', 'body', 'deliverables', 'valuePoints'],
  project: [
    'title',
    'projectType',
    'lead',
    'summary',
    'body',
    'scope',
    'goal',
    'result',
    'results',
    'keywords',
  ],
};

function pick(fields: readonly FieldDef[], names: readonly string[]): readonly FieldDef[] {
  return names.map((name) => {
    const field = fields.find((f) => f.name === name);
    if (!field) throw new Error(`template editor: the full editor has no field ${name}`);
    return field;
  });
}

/**
 * The item's fields, taken from the full editors' descriptors (ui/services.ts, ui/portfolio.ts):
 * module constants, so useEntitySave's `fields` keep their identity across renders.
 */
export const ITEM_FIELDS: Readonly<Record<TemplateKind, readonly FieldDef[]>> = {
  service: pick(servicesUi.fields, ITEM_FIELD_NAMES.service),
  project: pick(portfolioUi.fields, ITEM_FIELD_NAMES.project),
};

/** Where the item is saved: the full editor's resource (the one write path to its row). */
export const ITEM_TARGET = {
  service: { kind: 'resource', slug: 'services' },
  project: { kind: 'resource', slug: 'portfolio' },
} as const;

/** The shared text's singleton (`/api/admin/template-copy`). */
export const SHARED_TARGET = { kind: 'singleton', endpoint: '/api/admin/template-copy' } as const;

/** The item's full editor. */
export function fullEditorHref(kind: TemplateKind, id: string): string {
  return `/admin/${kind === 'service' ? 'services' : 'portfolio'}/${id}`;
}

/** The words for the item's kind: "service" / "project". */
export const NOUN: Readonly<Record<TemplateKind, string>> = {
  service: 'service',
  project: 'project',
};

/** The two things the fields column edits. */
export type TemplatePanel = 'item' | 'shared';

/** One line of the shared text, in words: its name and where the page shows it. */
interface CopyWords {
  label: string;
  help: string;
}

/** Every text key of the catalogue in words (an accent key's words are ACCENT_WORDS). */
export const COPY_WORDS: Readonly<Record<TemplateKind, Readonly<Record<string, CopyWords>>>> = {
  service: {
    services: {
      label: 'Services crumb',
      help: 'The first step of the crumb above the service name, which links to the Services page.',
    },
    home: {
      label: 'Home step',
      help: 'The first step of the page’s breadcrumb in search results.',
    },
    skipKicker: { label: 'Skip pill: question', help: 'The small line in the hero’s glass pill.' },
    skip: { label: 'Skip pill: link', help: 'The pill’s link to the inquiry form.' },
    seeCase: {
      label: 'Hero button',
      help: 'The hero’s button when the service has a case study. Without one, the button is the skip link’s words.',
    },
    whatTag: { label: 'Tag', help: 'The tag above the intro statement.' },
    get: { label: 'Deliverables heading', help: 'The heading above the deliverables.' },
    valueTag: { label: 'Tag', help: 'The tag above the value cards’ heading.' },
    valueHeading: { label: 'Heading', help: 'The heading above the value cards.' },
    valueLead: { label: 'Lead', help: 'The line beside the heading.' },
    caseTag: { label: 'Tag', help: 'The tag above the case study.' },
    seeProject: { label: 'Project link', help: 'The link to the full case study.' },
    context: { label: 'Context heading', help: 'Above where the client was before.' },
    problem: { label: 'Problem column', help: 'The heading of the problems column.' },
    did: { label: 'Solution column', help: 'The heading of what the studio did.' },
    helloLeadIn: {
      label: 'Heading lead-in',
      help: 'The words before the service’s name in the inquiry heading, which shows the name in colour.',
    },
    helloLead: { label: 'Lead', help: 'The line under the inquiry heading.' },
    moreTag: {
      label: 'Tag',
      help: 'The tag above the other services. {c} stands for the discipline’s name.',
    },
    moreLeadIn: {
      label: 'Heading lead-in',
      help: 'The words before the discipline’s name, which shows in colour.',
    },
    all: { label: 'All services link', help: 'The link to the Services page.' },
    fab: { label: 'Button', help: 'The floating button that skips to the inquiry form on phones.' },
  },
  project: {
    bannerTag: { label: 'Tag', help: 'The tag over the banner.' },
    back: { label: 'Back link', help: 'The link back to the projects, above the name.' },
    keywords: {
      label: 'Keyword list name',
      help: 'Read out by screen readers before the keywords.',
    },
    overview: { label: 'Overview heading', help: 'Above the lead and the overview.' },
    scope: { label: 'Scope heading', help: 'Above the numbered scope of work.' },
    goal: { label: 'Goal heading', help: 'Above the goal.' },
    result: { label: 'Result heading', help: 'Above the result and its figures.' },
    final: { label: 'Final film label', help: 'The label on the final film.' },
    breakdownTag: { label: 'Tag', help: 'The tag above the breakdown.' },
    breakdownHeading: { label: 'Heading', help: 'The heading above the breakdown stills.' },
    breakdownLead: { label: 'Lead', help: 'The line beside the heading.' },
    sketch: { label: 'Sketch label', help: 'On a sketch still.' },
    bts: { label: 'Behind the scenes label', help: 'On a behind the scenes still.' },
    process: { label: 'Process label', help: 'On a process still.' },
    galleryTag: { label: 'Tag', help: 'The tag above the gallery.' },
    galleryHeading: { label: 'Heading', help: 'The heading above the gallery.' },
    viewer: {
      label: 'Viewer name',
      help: 'Read out by screen readers when a still opens full size.',
    },
    viewerClose: { label: 'Close button', help: 'Read out by screen readers.' },
    viewerPrevious: { label: 'Previous button', help: 'Read out by screen readers.' },
    viewerNext: { label: 'Next button', help: 'Read out by screen readers.' },
    nextProject: { label: 'Next project', help: 'The label on the next project’s card.' },
  },
};

const ACCENT_WORDS = {
  label: 'Coloured words',
  help: 'Which words of your heading carry the colour. The built-in heading keeps its own.',
};

/** Long lines get a paragraph box (a lead), short ones a line. */
const LONG = 120;

const pairOf = (value: unknown): { en: string; ar: string } | undefined => {
  const v = (value && typeof value === 'object' ? value : null) as Row | null;
  return v && typeof v['en'] === 'string' && typeof v['ar'] === 'string'
    ? { en: v['en'], ar: v['ar'] }
    : undefined;
};

/**
 * The shared text as ONE form field: the template's column (`service` or `project`), an object
 * of every catalogue key, each line's built-in words its placeholder, drawn in one group per
 * part of the page. A line left blank in both languages is not stored: the page shows the
 * built-in words (formPayload omits a blank override inside an object).
 */
export function sharedField(kind: TemplateKind, builtIn: Readonly<Row>): FieldDef {
  const keys = TEMPLATE_COPY_KEYS[kind] as Readonly<
    Record<string, { kind: 'text'; max: number } | { kind: 'accent'; of: string }>
  >;
  const words = COPY_WORDS[kind];
  const itemFields: FieldDef[] = Object.entries(keys).map(([key, def]) => {
    if (def.kind === 'accent') {
      return { name: key, kind: 'accent', accent: { of: def.of, mode: 'range' }, ...ACCENT_WORDS };
    }
    const placeholder = pairOf(builtIn[key]);
    return {
      name: key,
      kind: 'bilingual',
      label: words[key]?.label ?? key,
      help: words[key]?.help ?? '',
      maxLength: def.max,
      ...(def.max > LONG ? { multiline: true } : {}),
      ...(placeholder ? { placeholder } : {}),
    } satisfies FieldDef;
  });
  return {
    name: kind,
    column: kind,
    kind: 'object',
    label: kind === 'service' ? 'Every service page' : 'Every project page',
    itemFields,
    itemGroups: TEMPLATE_PARTS[kind]
      .filter((part) => part.copy.length > 0)
      .map((part) => ({ id: part.key, title: part.name, fields: part.copy })),
  };
}

/** Every item the picker offers, in its order. */
export function itemsOf(groups: readonly TemplateItemGroup[]): TemplateItem[] {
  return groups.flatMap((group) => group.items);
}

/** The address with the item shown (`?item=`), for a reload or a link to land on it again. */
export function addressWithItem(href: string, id: string): string {
  const url = new URL(href);
  url.searchParams.set('item', id);
  return url.href;
}

/** A row's stamp: its version and its pending change's, which a save moves and a read does not. */
export function rowStamp(row: Row): string {
  const draft = (
    row['draft'] && typeof row['draft'] === 'object' ? row['draft'] : null
  ) as Row | null;
  return `${String(row['version'] ?? '')}|${String(draft?.['version'] ?? '')}`;
}

/** Whether a row the form read or saved moved since the last one (a save, not the first read). */
export function savedSince(before: string | null, row: Row): boolean {
  return before !== null && before !== rowStamp(row);
}

/** The preview's words for an item visitors cannot open yet. */
export function unpublishedNote(kind: TemplateKind, status: string): string | null {
  return status === 'published'
    ? null
    : `This ${NOUN[kind]} is not published, so visitors have no page for it yet and the preview may show the page not found.`;
}
