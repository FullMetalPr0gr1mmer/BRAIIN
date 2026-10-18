import { describe, expect, it } from 'vitest';
import {
  LeadBoardQuerySchema,
  LeadExportQuerySchema,
  LeadNeighboursQuerySchema,
  LeadQuerySchema,
  LeadSummaryQuerySchema,
} from '@schemas/crm';
import {
  DEFAULT_LEAD_FILTERS,
  boardQueryOf,
  exportHrefOf,
  leadFilterParams,
  listQueryOf,
  neighboursQueryOf,
  parseLeadFilters,
  summaryQueryOf,
  withLeadFilters,
  type LeadFilters,
} from '@/lib/crm/leadUrl';

// The leads screens' filters in the address (Admin v2 C4b): an allow-list, round-tripped, and
// never the search (verification D10). Every body it builds is one the API's own schema
// accepts, so a filter in the address cannot turn into a 422 on the screen.

const STAGE = '33333333-3333-4333-8333-333333333333';
const PERSON = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-17T12:00:00Z');

const parse = (query: string) => parseLeadFilters(new URLSearchParams(query));

describe('parseLeadFilters', () => {
  it('reads every filter the screens put in an address', () => {
    expect(
      parse(
        `stage=${STAGE}&assigned=${PERSON}&source=manual&channel=phone&discipline=events-and-exhibitions&range=30&sort=newest&page=3`,
      ),
    ).toEqual({
      chip: { kind: 'stage', id: STAGE },
      assigned: PERSON,
      source: 'manual',
      channel: 'phone',
      discipline: 'events-and-exhibitions',
      range: '30',
      sort: 'newest',
      page: 3,
    });
  });

  it('defaults to every lead, all time, starred first, page 1', () => {
    expect(parse('')).toEqual(DEFAULT_LEAD_FILTERS);
    expect(DEFAULT_LEAD_FILTERS.sort).toBe('starred');
  });

  it('reads the unread and spam views and the two assignee words', () => {
    expect(parse('stage=unread').chip).toEqual({ kind: 'unread' });
    expect(parse('stage=spam').chip).toEqual({ kind: 'spam' });
    expect(parse('assigned=me').assigned).toBe('me');
    expect(parse('assigned=none').assigned).toBe('none');
  });

  it('drops what it cannot read, and every key it does not know', () => {
    expect(
      parse(
        'stage=<script>&assigned=someone&source=fax&channel=pigeon&discipline=Bad_Slug&range=365&sort=name&page=-2&email=a@b.co&status=new',
      ),
    ).toEqual(DEFAULT_LEAD_FILTERS);
    expect(parse(`discipline=${'a'.repeat(65)}`).discipline).toBeNull();
    expect(parse('page=99999').page).toBe(1);
    expect(parse('page=9999').page).toBeLessThanOrEqual(668);
  });

  it('never reads a search from the address', () => {
    const filters = parse('q=sara%40example.com&search=acme');
    expect(filters).toEqual(DEFAULT_LEAD_FILTERS);
    expect(JSON.stringify(filters)).not.toContain('sara');
  });

  it('keeps a person’s id (any case) and a stage id, lower-cased', () => {
    expect(parse(`assigned=${PERSON.toUpperCase()}`).assigned).toBe(PERSON);
    expect(parse(`stage=${STAGE.toUpperCase()}`).chip).toEqual({ kind: 'stage', id: STAGE });
  });
});

describe('leadFilterParams', () => {
  const samples: LeadFilters[] = [
    DEFAULT_LEAD_FILTERS,
    { ...DEFAULT_LEAD_FILTERS, chip: { kind: 'spam' }, range: '7', page: 2 },
    {
      chip: { kind: 'stage', id: STAGE },
      assigned: 'me',
      source: 'web_form',
      channel: null,
      discipline: 'branding',
      range: '90',
      sort: 'score',
      page: 4,
    },
  ];

  it('round-trips, and leaves the defaults out', () => {
    for (const filters of samples) {
      expect(parseLeadFilters(leadFilterParams(filters))).toEqual(filters);
    }
    expect(leadFilterParams(DEFAULT_LEAD_FILTERS).toString()).toBe('');
    expect(withLeadFilters('/admin/leads', DEFAULT_LEAD_FILTERS)).toBe('/admin/leads');
    expect(withLeadFilters('/admin/leads', samples[1]!)).toBe(
      '/admin/leads?stage=spam&range=7&page=2',
    );
  });

  it('never writes a search', () => {
    const sneaky = { ...DEFAULT_LEAD_FILTERS, q: 'sara@example.com' } as LeadFilters;
    expect(leadFilterParams(sneaky).has('q')).toBe(false);
    expect(leadFilterParams(sneaky).toString()).not.toContain('sara');
  });
});

describe('the bodies the filters become', () => {
  const ranged: LeadFilters = {
    chip: { kind: 'unread' },
    assigned: 'none',
    source: 'manual',
    channel: 'walk_in',
    discipline: 'branding',
    range: '7',
    sort: 'oldest',
    page: 2,
  };

  it('the list: the chip, the shared filters, the range start and the page (15 a page)', () => {
    const body = listQueryOf(ranged, NOW);
    expect(body).toEqual({
      unread: true,
      assigned: 'none',
      source: 'manual',
      channel: 'walk_in',
      discipline: 'branding',
      from: '2026-10-10T21:00:00.000Z',
      sort: 'oldest',
      limit: 15,
      offset: 15,
    });
    expect(LeadQuerySchema.safeParse(body).success).toBe(true);
    expect(listQueryOf({ ...DEFAULT_LEAD_FILTERS, chip: { kind: 'spam' } }, NOW)).toEqual({
      spam: true,
      sort: 'starred',
      limit: 15,
      offset: 0,
    });
  });

  it('the neighbours: the list’s filter, no search and no page', () => {
    const body = neighboursQueryOf({ ...ranged, chip: { kind: 'stage', id: STAGE } }, NOW);
    expect(body).not.toHaveProperty('limit');
    expect(body).not.toHaveProperty('offset');
    expect(body).not.toHaveProperty('q');
    expect(body['stage' as keyof typeof body]).toBe(STAGE);
    expect(LeadNeighboursQuerySchema.safeParse(body).success).toBe(true);
  });

  it('the board: no chip, sort or page (the board refuses them), 50 a column', () => {
    const body = boardQueryOf({ ...ranged, chip: { kind: 'spam' } }, NOW);
    expect(body).toEqual({
      assigned: 'none',
      source: 'manual',
      channel: 'walk_in',
      discipline: 'branding',
      from: '2026-10-10T21:00:00.000Z',
      perStage: 50,
    });
    expect(LeadBoardQuerySchema.safeParse(body).success).toBe(true);
  });

  it('the KPIs: the range only, to now; nothing for all time', () => {
    expect(summaryQueryOf(ranged, NOW)).toEqual({
      from: '2026-10-10T21:00:00.000Z',
      to: '2026-10-17T12:00:00.000Z',
    });
    expect(summaryQueryOf(DEFAULT_LEAD_FILTERS, NOW)).toEqual({});
    expect(LeadSummaryQuerySchema.safeParse(summaryQueryOf(ranged, NOW)).success).toBe(true);
  });

  it('the export link: the list’s filters as the export reads them, never a search', () => {
    const href = exportHrefOf(ranged, NOW);
    const url = new URL(href, 'https://admin.invalid');
    expect(url.pathname).toBe('/api/admin/leads/export');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: '2026-10-10T21:00:00.000Z',
      unread: 'true',
      assigned: 'none',
      source: 'manual',
      channel: 'walk_in',
      discipline: 'branding',
    });
    expect(LeadExportQuerySchema.safeParse(Object.fromEntries(url.searchParams)).success).toBe(
      true,
    );
    expect(exportHrefOf(DEFAULT_LEAD_FILTERS, NOW)).toBe('/api/admin/leads/export');
    expect(exportHrefOf({ ...DEFAULT_LEAD_FILTERS, chip: { kind: 'spam' } }, NOW)).toBe(
      '/api/admin/leads/export?spam=true',
    );
    expect(href).not.toContain('q=');
  });
});
