import { readFileSync, readdirSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import LeadsList, { hoursText } from '@/components/admin/screens/leads/LeadsList';
import LeadsBoard, {
  cardTakesFocus,
  focusTargetAfterMove,
} from '@/components/admin/screens/leads/LeadsBoard';
import LeadDetail from '@/components/admin/screens/leads/LeadDetail';
import LeadContactCard, { whatsappHref } from '@/components/admin/screens/leads/LeadContactCard';
import { reasonsSentence } from '@/components/admin/screens/leads/LeadStatusCard';
import { focusAfterMove } from '@/components/admin/screens/leads/MoveTo';
import AddLeadDrawer, {
  checkManualLead,
  manualLeadBody,
} from '@/components/admin/screens/leads/AddLeadDrawer';
import { LeadManualCreateSchema } from '@schemas/crm';
import type { LeadsFrame } from '@/lib/crm/leadPage';
import { DEFAULT_LEAD_FILTERS } from '@/lib/crm/leadUrl';

// The leads screens' first render (Admin v2 C4b): the HTML each island draws on the server,
// before any read of its own (crm.md §11 "PII rules", CLAUDE.md §3). What it holds:
//   • no style attribute anywhere (style-src has no 'unsafe-inline');
//   • a row, a card and a lead's page carry the safe columns only: no budget column, no
//     e-mail, phone, budget or note, no mailto/tel/WhatsApp link before the audited reveal;
//   • states are words, never colour or weight alone: "Unread", "Over response time", the
//     star's pressed state, the board's counts;
//   • "Move to…" names its card; the board scrolls in its own focusable region;
//   • the revealed values live in component state only (no storage, no address).

const NOW = '2026-10-18T09:00:00.000Z';
const NEW = '11111111-1111-4111-8111-111111111111';
const WON = '22222222-2222-4222-8222-222222222222';
const SARA = '33333333-3333-4333-8333-333333333333';
const LEAD = '44444444-4444-4444-8444-444444444444';
const OLD = '55555555-5555-4555-8555-555555555555';

const FRAME: LeadsFrame = {
  stages: [
    { id: NEW, key: 'new', label: 'New', tone: 'klein', kind: 'open', isInitial: true },
    { id: WON, key: 'won', label: 'Won', tone: 'ok', kind: 'won', isInitial: false },
  ],
  people: [{ id: SARA, name: 'Sara' }],
  disciplines: [
    { slug: 'branding', name: 'Branding', services: [{ slug: 'logo', name: 'Logo Design' }] },
  ],
};
const PERMS = { canSeePii: true, canExport: true, canErase: true, canEditServices: true };

const row = (over: Record<string, unknown> = {}) => ({
  id: LEAD,
  lead_number: 12,
  name: 'Nora Haddad',
  company: 'Acme',
  message_preview: 'We need a logo',
  service_of_interest: 'logo',
  discipline_of_interest: null,
  stage_id: NEW,
  is_spam: false,
  score: 60,
  source: 'web_form',
  channel: 'unknown',
  created_at: '2026-10-17T09:00:00.000Z',
  first_response_at: null,
  won_at: null,
  version: 3,
  assigned_to: SARA,
  value_sar: null,
  is_starred: true,
  read_at: null,
  last_contact_at: null,
  last_contact_channel: null,
  over_sla: true,
  service_label: { en: 'Logo Design', ar: 'تصميم الشعار' },
  ...over,
});

const SUMMARY = {
  total: 7,
  new: 3,
  open: 5,
  won: 1,
  lost: 1,
  spam: 2,
  in_progress: 2,
  unread: 4,
  starred: 1,
  sla_breached: 1,
  web_response_n: 2,
  won_value: 50000,
  avg_first_response_hours: 3,
  web_response_hours: 3,
  conversion: 1 / 7,
  per_stage: { [NEW]: 3, [WON]: 1 },
  previous: null,
};

const html = <P extends object>(component: (props: P) => unknown, props: P) =>
  renderToStaticMarkup(createElement(component as never, props as never));

/** Words a person's contact details or budget would show as, or link through. */
const PII = /@|mailto:|tel:|wa\.me|budget|Budget|\+966/;

describe('the list', () => {
  const out = html(LeadsList, {
    frame: FRAME,
    initial: {
      summary: SUMMARY,
      page: {
        rows: [row(), row({ id: OLD, read_at: NOW, over_sla: false, is_starred: false })],
        total: 2,
      },
    },
    filters: DEFAULT_LEAD_FILTERS,
    permissions: PERMS,
    now: NOW,
  });

  it('draws no style attribute, no budget column and no contact detail', () => {
    expect(out).not.toMatch(/\sstyle=/);
    expect(out).not.toMatch(/<th[^>]*>Budget/);
    expect(out).not.toMatch(PII);
  });

  it('says unread and over the response time in words, not weight or colour alone', () => {
    expect(out).toContain('<span class="visually-hidden"> Unread</span>');
    expect(out.match(/Unread<\/span>/g)?.length).toBe(1);
    expect(out).toContain('<span class="lead-sla">Over response time</span>');
    expect(out.match(/Over response time/g)?.length).toBe(1);
  });

  it('names each star by its lead, pressed or not', () => {
    expect(out).toMatch(/aria-pressed="true"[^>]*aria-label="Star Nora Haddad"/);
    expect(out).toMatch(/aria-pressed="false"[^>]*aria-label="Star Nora Haddad"/);
  });

  it('links a lead to its page with the list’s filters, never a search', () => {
    expect(out).toContain(`href="/admin/leads/${LEAD}"`);
    expect(out).not.toMatch(/href="[^"]*[?&]q=/);
  });

  it('shows the five KPIs, and "Not enough data yet" under five answered web leads', () => {
    for (const label of ['New', 'In progress', 'Won', 'Won of all leads', 'Average first response'])
      expect(out).toContain(`<p class="stat-label">${label}</p>`);
    expect(out).toContain('<span class="stat-unit">50,000 SAR</span>');
    expect(out).toContain('Not enough data yet');
    expect(out).toContain('14%');
    // All time: no change pill (no invented trend).
    expect(out).not.toContain('kpi__d');
  });

  it('counts the chips by stage, unread and spam, for the range', () => {
    expect(out).toMatch(/aria-pressed="true"[^>]*>All <span class="chip__n">7<\/span>/);
    expect(out).toContain('Unread <span class="chip__n">4</span>');
    expect(out).toContain('Spam <span class="chip__n">2</span>');
  });

  it('labels every filter, and offers no channel until "Added by hand" is chosen', () => {
    for (const label of ['Discipline', 'Source', 'Assigned', 'Range', 'Sort'])
      expect(out).toMatch(new RegExp(`<label class="f__l" for="[^"]+">${label}</label>`));
    expect(out).not.toContain('How they reached us');
    const manual = html(LeadsList, {
      frame: FRAME,
      initial: { summary: SUMMARY, page: { rows: [], total: 0 } },
      filters: { ...DEFAULT_LEAD_FILTERS, source: 'manual' },
      permissions: PERMS,
      now: NOW,
    });
    expect(manual).toContain('How they reached us');
    expect(manual).toContain('No leads match');
  });
});

describe('the board', () => {
  const out = html(LeadsBoard, {
    frame: FRAME,
    initial: [
      { stage_id: NEW, total: 60, value_sum: 0, leads: [row()] },
      {
        stage_id: WON,
        total: 1,
        value_sum: 75000,
        leads: [row({ id: OLD, name: 'Omar', stage_id: WON, value_sar: 75000, read_at: NOW })],
      },
    ] as never,
    filters: DEFAULT_LEAD_FILTERS,
    permissions: PERMS,
    now: NOW,
  });

  it('scrolls in its own labelled, focusable region; no style, no contact detail', () => {
    expect(out).toContain('<div class="kb" role="region" aria-label="Pipeline" tabindex="0">');
    expect(out).not.toMatch(/\sstyle=/);
    expect(out).not.toMatch(PII);
  });

  it('gives every card a "Move to…" that names it, closed until pressed', () => {
    expect(out).toContain('Move to…<span class="visually-hidden"> Nora Haddad</span>');
    expect(out).toContain('Move to…<span class="visually-hidden"> Omar</span>');
    expect(out).toMatch(/aria-haspopup="true" aria-expanded="false"/);
    expect(out).not.toContain('moveto__m');
  });

  it('adds up the won column in SAR, counts each column, and links past the 50 shown', () => {
    expect(out).toContain('<span class="kb__sum">75,000 SAR</span>');
    expect(out).toContain('60<span class="visually-hidden"> leads</span>');
    expect(out).toContain(`href="/admin/leads?stage=${NEW}"`);
    expect(out).toContain('Show all 60 in the list');
    expect(out).toContain('<span class="visually-hidden">Unread</span>');
  });

  it('carries only the filters its toolbar shows into its cards (no chip, sort or page)', () => {
    // A list's address pasted onto the board: the board shows no chip, sort or page, so its
    // cards' links (and its own address) never carry them (boardFilters).
    const pasted = html(LeadsBoard, {
      frame: FRAME,
      initial: [{ stage_id: NEW, total: 1, value_sum: 0, leads: [row()] }] as never,
      filters: {
        ...DEFAULT_LEAD_FILTERS,
        chip: { kind: 'spam' },
        sort: 'oldest',
        page: 4,
        range: '30',
      },
      permissions: PERMS,
      now: NOW,
    });
    expect(pasted).toContain(`href="/admin/leads/${LEAD}?range=30"`);
    expect(pasted).not.toMatch(/href="\/admin\/leads\/[^"]*(stage=spam|sort=|page=)/);
  });

  it('gives focus to the moved card only when focus was lost with its old place', () => {
    // C4b's "Move to…" rule on the board: the card's link takes focus after a move (its
    // button left for another column) or a conflict's refresh that moved it, never from where
    // the person went meanwhile, nor from its own button that stayed put.
    const body = { tag: 'body' } as unknown as Element;
    const field = { tag: 'input' } as unknown as Element;
    expect(cardTakesFocus(body, body)).toBe(true);
    expect(cardTakesFocus(null, body)).toBe(true);
    expect(cardTakesFocus(field, body)).toBe(false);
    const source = readFileSync('src/components/admin/screens/leads/LeadsBoard.tsx', 'utf8');
    expect(source).toContain('if (!cardTakesFocus(document.activeElement, document.body)) return;');
    // A conflict's refresh follows the card too.
    expect(source).toMatch(
      /status === 409\) \{\n[^\n]*\n[^\n]*\n\s*focusAfter\.current = \{ id: card\.id, from: String\(card\.stage_id\) \};/,
    );
  });

  it('gives focus to the column the card left when the refresh no longer holds it', () => {
    // A conflict's refresh can drop the card: a colleague marked it spam (the board leaves
    // spam out) or it now falls outside the filters. Its "Move to…" left with it, so focus
    // goes to the heading of the column it left, else the board, never the body (WCAG 2.4.3).
    const link = { tag: 'a' } as unknown as HTMLElement;
    const heading = { tag: 'h2' } as unknown as HTMLElement;
    const board = { tag: 'div.kb' } as unknown as HTMLElement;
    const rootOf = (found: Record<string, HTMLElement>) => ({
      querySelector: <E extends Element>(selector: string) => (found[selector] ?? null) as E | null,
    });
    const cardSel = `[data-lead-card="${LEAD}"] .kcard__n`;
    const colSel = `[id="kb-${NEW}"]`;
    expect(
      focusTargetAfterMove(rootOf({ [cardSel]: link, [colSel]: heading, '.kb': board }), LEAD, NEW),
    ).toBe(link);
    expect(focusTargetAfterMove(rootOf({ [colSel]: heading, '.kb': board }), LEAD, NEW)).toBe(
      heading,
    );
    expect(focusTargetAfterMove(rootOf({ '.kb': board }), LEAD, NEW)).toBe(board);
    // The heading the selector names is the column's, and it can take focus.
    expect(out).toContain(`<h2 id="kb-${NEW}" class="kb__t" tabindex="-1">`);
    const source = readFileSync('src/components/admin/screens/leads/LeadsBoard.tsx', 'utf8');
    expect(source).toContain('focusTargetAfterMove(document, after.id, after.from)?.focus();');
  });

  it('reads the address through boardFilters on the server too', () => {
    const page = readFileSync('src/pages/admin/leads/board.astro', 'utf8');
    expect(page).toContain('boardFilters(parseLeadFilters(Astro.url.searchParams))');
  });
});

describe('a lead’s page', () => {
  const props = {
    lead: {
      ...row(),
      message: 'We need a logo for our café.',
      locale: 'en',
      tags: ['hot'],
      consent_marketing: true,
    } as never,
    neighbours: { prev: null, next: null },
    events: [
      { id: 1, at: '2026-10-17T09:00:00.000Z', kind: 'created', actor_id: null, detail: {} },
    ],
    before: null,
    serviceHref: '/admin/services/abc',
    stages: FRAME.stages,
    people: FRAME.people,
    permissions: PERMS,
    me: { id: SARA, name: 'Sara' },
    sameEmail: [],
    now: NOW,
  };
  const out = html(LeadDetail, props);

  it('masks the contact details and offers the logged reveal; no link before it', () => {
    expect(out.match(/<span class="lead-masked">Hidden<\/span>/g)?.length).toBe(4);
    expect(out).toContain('Reveal contact details (this access is logged)');
    expect(out).not.toMatch(/mailto:|tel:|wa\.me/);
    expect(out).not.toMatch(/\sstyle=/);
  });

  it('keeps the score’s reasons behind the reveal (decision D7)', () => {
    expect(out).toContain('60 / 100');
    expect(out).toContain('data-width="60" data-band="klein"');
    expect(out).toContain('Reasons show with the contact details.');
    expect(out).not.toContain('Because they');
  });

  it('reads the message in its own direction and language; the timeline in sentences', () => {
    expect(out).toContain('<blockquote class="lead-quote" dir="auto" lang="en">');
    expect(out).toContain('Arrived through the website form');
    expect(out).toContain('Agreed to be contacted about this inquiry');
    expect(out).toContain('#12');
    expect(out).toContain('href="/admin/services/abc"');
  });

  it('offers Erase only to an Admin, notes only to those who may see contact details', () => {
    expect(out).toContain('More actions');
    expect(out).toContain('Only your team sees these.');
    const developer = html(LeadDetail, {
      ...props,
      permissions: { ...PERMS, canErase: false, canEditServices: false },
      serviceHref: null,
    });
    expect(developer).not.toContain('More actions');
    expect(developer).not.toContain('href="/admin/services/');
    const noPii = html(LeadDetail, { ...props, permissions: { ...PERMS, canSeePii: false } });
    expect(noPii).not.toContain('Reveal contact details');
    expect(noPii).not.toContain('Only your team sees these.');
  });
});

describe('contact details after the reveal', () => {
  const revealed = {
    email: 'nora@example.test',
    phone: '+966 50 123 4567',
    budget: '75k_200k',
    timeline: null,
    timeline_band: 'asap',
    score_reasons: ['named_service' as const, 'budget_given' as const],
  };

  it('shows the values left to right, with Email, Call and WhatsApp links', () => {
    const out = html(LeadContactCard, {
      leadId: LEAD,
      revealed,
      onRevealed: () => undefined,
      onLogged: () => undefined,
    });
    expect(out).toContain('href="mailto:nora@example.test"');
    expect(out).toContain('href="tel:+966 50 123 4567"');
    expect(out).toContain('href="https://wa.me/966501234567"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('<span dir="ltr">nora@example.test</span>');
    expect(out).toContain('75k to 200k SAR');
    expect(out).toContain('As soon as possible (legacy band)');
    expect(out).toContain('Log contact');
    expect(out).not.toContain('lead-masked');
    expect(whatsappHref('+966 (50) 123-4567')).toBe('https://wa.me/966501234567');
  });

  it('says why the lead scores what it scores, in words', () => {
    expect(reasonsSentence(['named_service', 'budget_given'])).toBe(
      'Because they named a service and gave a budget.',
    );
    expect(reasonsSentence([])).toBe('No strong signals yet.');
  });

  it('keeps the revealed values in component state: no storage, cookie or address', () => {
    const dir = 'src/components/admin/screens/leads';
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      expect(source, file).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
      // The address is written from the filters only (leadUrl), never from a lead's values.
      for (const m of source.matchAll(/history\.replaceState\(([^)]*)\)/g))
        expect(m[1], file).toMatch(/null, '', href/);
    }
  });
});

describe('the add drawer', () => {
  const EMPTY = {
    name: '',
    company: '',
    email: '',
    phone: '',
    service: '',
    budget: '',
    timeline: '',
    message: '',
    locale: 'en' as const,
    channel: 'phone' as const,
  };

  it('asks for a name, a message and an e-mail or a phone, before it asks the server', () => {
    expect(checkManualLead(EMPTY)).toEqual({
      name: 'Give the lead a name.',
      message: 'Write what they asked for.',
      email: 'Add an e-mail address or a phone number.',
    });
    expect(checkManualLead({ ...EMPTY, name: 'N', message: 'M', phone: '0501234567' })).toEqual({});
  });

  it('sends what the route accepts, empty boxes left out, "Add as someone new" as createNew', () => {
    const body = manualLeadBody(
      { ...EMPTY, name: ' Nora ', message: ' Hi ', phone: '0501234567', service: 'logo' },
      true,
    );
    expect(body).toEqual({
      name: 'Nora',
      message: 'Hi',
      phone: '0501234567',
      serviceOfInterest: 'logo',
      locale: 'en',
      channel: 'phone',
      createNew: true,
    });
    expect(LeadManualCreateSchema.safeParse(body).success).toBe(true);
  });

  it('groups the services by discipline, labels every field and draws no style', () => {
    const out = html(AddLeadDrawer, {
      open: true,
      onClose: () => undefined,
      disciplines: FRAME.disciplines,
    });
    expect(out).toContain(
      '<optgroup label="Branding"><option value="logo">Logo Design</option></optgroup>',
    );
    for (const label of [
      'Name',
      'Company',
      'E-mail',
      'Phone or WhatsApp',
      'Service',
      'Budget',
      'When do you need it?',
      'Message',
      'Language',
      'How they reached us',
    ])
      expect(out, label).toContain(`<span>${label}`);
    expect(out).toContain('<span class="visually-hidden"> (required)</span>');
    expect(out).not.toMatch(/\sstyle=/);
  });
});

describe('"Move to…" after a move', () => {
  // A chosen stage closes the list that held focus, and the lead's page disables the button
  // while the move is saved, which drops focus to the body. The button takes it back once
  // enabled, never from where the person went meanwhile (WCAG 2.4.3). The browser half is
  // tests/admin/leads.e2e.ts.
  const body = { tag: 'body' } as unknown as Element;
  const button = { tag: 'button' } as unknown as Element;
  const field = { tag: 'input' } as unknown as Element;

  it('gives focus back to the button once the move has settled', () => {
    expect(focusAfterMove(true, false, body, button, body)).toBe(true);
    expect(focusAfterMove(true, false, null, button, body)).toBe(true);
    expect(focusAfterMove(true, false, button, button, body)).toBe(true);
  });

  it('waits while the button is disabled, and takes nothing it was not asked for', () => {
    expect(focusAfterMove(true, true, body, button, body)).toBe(false);
    expect(focusAfterMove(false, false, body, button, body)).toBe(false);
    expect(focusAfterMove(true, false, field, button, body)).toBe(false);
    expect(focusAfterMove(true, false, body, null, body)).toBe(false);
  });

  it('is wired: a chosen stage marks the move, and the effect gives focus back', () => {
    const source = readFileSync('src/components/admin/screens/leads/MoveTo.tsx', 'utf8');
    expect(source).toContain('pending.current = true;');
    expect(source).toMatch(/focusAfterMove\(pending\.current, off,/);
    expect(source).toContain('}, [off]);');
  });
});

describe('words', () => {
  it('a first response in hours and minutes', () => {
    expect(hoursText(0.5)).toBe('30 min');
    expect(hoursText(3 + 40 / 60)).toBe('3 h 40 min');
    expect(hoursText(2)).toBe('2 h');
    expect(hoursText(52)).toBe('2 d 4 h');
  });
});
