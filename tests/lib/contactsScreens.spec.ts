import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ContactsList from '@/components/admin/screens/contacts/ContactsList';
import ContactDetail from '@/components/admin/screens/contacts/ContactDetail';
import ContactChannelsCard from '@/components/admin/screens/contacts/ContactChannelsCard';
import {
  checkContact,
  contactBody,
  issueField,
  tagsOf,
} from '@/components/admin/screens/contacts/AddContactDrawer';
import { forgetOnLeave } from '@/components/admin/screens/contacts/shared';
import CommandPalette from '@/components/admin/screens/chrome/CommandPalette';
import {
  erasedLine,
  erasedTasks,
  eraseStep,
  type ErasePreview,
} from '@/components/admin/screens/contacts/EraseContactDialog';
import { detailsPatch } from '@/components/admin/screens/contacts/ContactDetailsCard';
import ContactLeadsCard, {
  checkErrorText,
  copiedWords,
} from '@/components/admin/screens/contacts/ContactLeadsCard';
import { REVEAL_LIMIT_TEXT } from '@/components/admin/screens/contacts/ContactChannelsCard';
import { AdminApiError } from '@/lib/admin/client';
import { ContactCreateSchema, ContactPatchSchema, ContactQuerySchema } from '@schemas/crm';
import {
  DEFAULT_CONTACT_FILTERS,
  contactQueryOf,
  parseContactFilters,
  withContactFilters,
} from '@/lib/crm/contactUrl';
import {
  addMonths,
  contactEventSentence,
  contactsSubline,
  leadTotals,
  roleLine,
  tagsShown,
  type ContactEvent,
  type ContactLead,
} from '@/lib/crm/contactView';
import { contactGroup, looksLikeContactDetail, searchRequest } from '@/lib/admin/palette';
import type { StageView } from '@/lib/crm/leadPage';

// The contacts screens (Admin v2 C7, crm.md §11 screens 5 to 8 and its "PII rules"): the HTML
// each island draws on the server, before any read of its own, and the pure rules the islands
// run. What it holds:
//   • no style attribute anywhere (style-src has no 'unsafe-inline');
//   • a row and a contact's page carry no e-mail, phone or note, and no mailto/tel/WhatsApp
//     link before the audited reveal; the details are masked words;
//   • states are words: the stage, "Phone match to check", the star's pressed state;
//   • the address never carries the search or a tag; every body the screens send passes the
//     API's own schema;
//   • the erasure needs a reason and a second press; the palette's searches are POSTs, so no
//     typed term goes in a URL (C7 review); revealed details are forgotten when the page is left.

const NOW = '2026-11-10T09:00:00.000Z';
const ID = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const SARA = '33333333-3333-4333-8333-333333333333';
const WON = '22222222-2222-4222-8222-222222222222';
const NEW = '11111111-1111-4111-8111-111111111111';
const PEOPLE = [{ id: SARA, name: 'Sara', canOwn: true }];
const STAGES: StageView[] = [
  { id: NEW, key: 'new', label: 'New', tone: 'klein', kind: 'open', isInitial: true },
  { id: WON, key: 'won', label: 'Won', tone: 'ok', kind: 'won', isInitial: false },
];

/** What a person's contact details would show as, or link through. */
const PII = /@|mailto:|tel:|wa\.me|\+966/;

const html = <P extends object>(component: (props: P) => unknown, props: P) =>
  renderToStaticMarkup(createElement(component as never, props as never));

const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  display_name: 'Nora Haddad',
  company_name: 'Acme',
  title: 'Designer',
  stage: 'client',
  source: 'web_form',
  owner_id: SARA,
  locale: 'en',
  city: null,
  country: null,
  tags: ['vip', 'expo', 'design', 'retail'],
  is_starred: true,
  last_activity_at: '2026-11-09T09:00:00.000Z',
  expires_at: '2028-11-09T09:00:00.000Z',
  created_at: '2026-10-01T09:00:00.000Z',
  version: 3,
  has_email: true,
  has_phone: true,
  leads: 2,
  to_check: 1,
  value: 50000,
  score: 72,
  ...over,
});

const SUMMARY = {
  total: 12,
  lead: 8,
  client: 3,
  past: 1,
  partner: 0,
  starred: 2,
  mine: 4,
  expiring: 1,
  to_check: 1,
};

describe('the People list', () => {
  const out = html(ContactsList, {
    initial: {
      summary: SUMMARY,
      page: {
        rows: [row(), row({ id: OTHER, to_check: 0, is_starred: false, tags: [] })],
        total: 2,
      },
    },
    filters: DEFAULT_CONTACT_FILTERS,
    people: PEOPLE,
    me: SARA,
    now: NOW,
  });

  it('draws no style attribute and no contact detail', () => {
    expect(out).not.toMatch(/\sstyle=/);
    expect(out).not.toMatch(PII);
  });

  it('says states in words: the stage, a phone match to check, the star', () => {
    expect(out).toContain('Client');
    expect(out).toContain('Phone match to check');
    expect(out).toContain('aria-label="Star Nora Haddad"');
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('aria-pressed="false"');
  });

  it('shows three tags then how many more, the value in SAR, and the chips with counts', () => {
    expect(out).toContain('vip');
    expect(out).toContain('design');
    expect(out).not.toContain('retail');
    expect(out).toMatch(/\+1<span class="visually-hidden"> more<\/span>/);
    expect(out).toContain('50,000 SAR');
    expect(out).toContain('Expiring soon');
    expect(out).toContain('Past client');
  });

  it('links each person by id only', () => {
    expect(out).toContain(`href="/admin/contacts/${ID}"`);
  });
});

describe('a contact’s page', () => {
  const props = {
    contact: { ...row(), custom: {}, updated_at: NOW, created_by: null, updated_by: null },
    channels: [
      { id: OTHER, kind: 'email', is_primary: true, source: 'lead' },
      { id: SARA, kind: 'phone', is_primary: true, source: 'lead' },
    ],
    leads: [
      {
        id: OTHER,
        lead_number: 12,
        name: 'Nora Haddad',
        company: 'Acme',
        stage_id: WON,
        is_spam: false,
        score: 72,
        value_sar: 50000,
        created_at: '2026-10-01T09:00:00.000Z',
        contact_link: 'email',
        source: 'web_form',
      },
      {
        id: ID,
        lead_number: 13,
        name: 'N. Haddad',
        company: null,
        stage_id: NEW,
        is_spam: false,
        score: 95,
        value_sar: null,
        created_at: '2026-10-05T09:00:00.000Z',
        contact_link: 'phone',
        source: 'web_form',
      },
    ] satisfies ContactLead[],
    moreLeads: false,
    timeline: {
      events: [
        {
          src: 'contact',
          id: 1,
          at: NOW,
          actor_id: SARA,
          kind: 'note_added',
          detail: {},
          lead_id: null,
          lead_number: null,
        },
      ],
      next: null,
    },
    customFields: [],
    retentionMonths: 24,
    leadStages: STAGES,
    people: PEOPLE,
    me: { id: SARA, name: 'Sara' },
    now: NOW,
  };
  const admin = html(ContactDetail, {
    ...props,
    permissions: { canErase: true, canAddLead: true, confirmIsReveal: false },
  } as never);
  const plain = html(ContactDetail, {
    ...props,
    permissions: { canErase: false, canAddLead: false, confirmIsReveal: false },
  } as never);
  // Sales (C10b): adds leads, erases nothing, and a confirm costs it a reveal slot.
  const sales = html(ContactDetail, {
    ...props,
    permissions: { canErase: false, canAddLead: true, confirmIsReveal: true },
  } as never);

  it('draws no style attribute, and masks the details until the audited reveal', () => {
    expect(admin).not.toMatch(/\sstyle=/);
    expect(admin).not.toMatch(PII);
    expect(admin).toContain('Hidden');
    expect(admin).toContain('Reveal contact details (this access is logged)');
    expect(admin).toContain('E-mail (main)');
  });

  it('asks about a lead matched by phone alone', () => {
    expect(admin).toContain('Matched by phone number only. Is this the same person?');
    expect(admin).toContain('Yes, same person');
    expect(admin).toContain('Not this person');
  });

  it('scores and values from leads linked other than by phone', () => {
    expect(admin).toMatch(/<strong>72<\/strong> \/ 100/);
    expect(admin).toContain('Won so far: 50,000 SAR');
  });

  it('says how long the data is kept', () => {
    expect(admin).toContain('kept until');
    expect(admin).toContain('unless there is new activity');
  });

  it('offers New lead and the erasure only to the roles that may', () => {
    expect(admin).toContain('New lead');
    expect(admin).toContain('Erase everything about them…');
    expect(plain).not.toContain('New lead<');
    expect(plain).not.toContain('Erase everything about them');
  });

  it('keeps names in their own direction', () => {
    expect(admin).toMatch(/<span dir="auto">Nora Haddad<\/span>/);
  });

  // C10b review, C10B-COR-3: for a role that pays a reveal slot to confirm, the button says so.
  it('says a confirm is a logged reveal to the roles it costs one', () => {
    expect(sales).toContain('Yes, same person (counts as a logged reveal)');
    expect(admin).toContain('Yes, same person');
    expect(admin).not.toContain('counts as a logged reveal');
  });
});

describe('the contact page words a confirm by the role (C10b review, C10B-COR-3)', () => {
  it('a confirm past the reveal limit says so in the reveal’s own words', () => {
    const limited = new AdminApiError({ error: 'rate-limit', status: 429 });
    expect(checkErrorText(limited)).toBe(REVEAL_LIMIT_TEXT);
    expect(checkErrorText(new Error('boom'))).not.toBe(REVEAL_LIMIT_TEXT);
  });
  it('the page tells the card who pays a reveal slot, from the export rule the route uses', () => {
    const page = readFileSync('src/pages/admin/contacts/[id].astro', 'utf8');
    expect(page).toContain('confirmIsReveal: allowed && !receivesLeadPiiUnasked(session.role)');
    const route = readFileSync('src/pages/api/admin/crm/contacts/[id]/links.ts', 'utf8');
    expect(route).toContain("input.action === 'confirm' && !receivesLeadPiiUnasked(auth.role)");
    const detail = readFileSync('src/components/admin/screens/contacts/ContactDetail.tsx', 'utf8');
    expect(detail).toContain('confirmIsReveal={permissions.confirmIsReveal}');
    expect(detail).toContain('canRemove={permissions.canErase}');
  });
});

describe('the contact details card after a reveal', () => {
  const channels = [
    { id: OTHER, kind: 'email', is_primary: true, source: 'manual' },
    { id: SARA, kind: 'phone', is_primary: true, source: 'lead' },
  ];
  const card = (revealed: Map<string, string | null>) =>
    html(ContactChannelsCard, {
      contactId: ID,
      channels,
      revealed,
      onRevealed: () => undefined,
      busy: false,
      canRemove: true,
      edit: async () => true,
    });

  it('shows what was revealed, with its links, and offers no second reveal', () => {
    const out = card(
      new Map([
        [OTHER, 'nora@example.test'],
        [SARA, '+966551234567'],
      ]),
    );
    expect(out).toContain('nora@example.test');
    expect(out).toContain('href="mailto:nora@example.test"');
    expect(out).toContain('href="https://wa.me/966551234567"');
    expect(out).not.toContain('Reveal contact details');
    expect(out).not.toMatch(/\sstyle=/);
  });

  // C7 review, C7-UX-5: nothing to reveal is no reveal (no slot spent, no audit row for
  // nothing); the first e-mail or phone is added straight away.
  it('offers no reveal for a contact with no e-mail or phone, and lets one be added', () => {
    const out = html(ContactChannelsCard, {
      contactId: ID,
      channels: [],
      revealed: null,
      onRevealed: () => undefined,
      busy: false,
      canRemove: false,
      edit: async () => true,
    });
    expect(out).toContain('No e-mail address or phone number yet.');
    expect(out).not.toContain('Reveal contact details');
    expect(out).toContain('An e-mail address');
    expect(out).toMatch(/<button type="submit"[^>]*>Add<\/button>/);
  });

  // C10b review, C10B-SEC-2: removing a detail is erasure's (Admin); Sales adds and makes main.
  it('offers Remove only to the roles that may erase', () => {
    const revealed = new Map([
      [OTHER, 'nora@example.test'],
      [SARA, '+966551234567'],
    ]);
    expect(card(revealed)).toContain('Remove<span class="visually-hidden">');
    const without = html(ContactChannelsCard, {
      contactId: ID,
      channels: [...channels, { id: NEW, kind: 'phone', is_primary: false, source: 'manual' }],
      revealed: new Map([...revealed, [NEW, '+966551234568']]),
      onRevealed: () => undefined,
      busy: false,
      canRemove: false,
      edit: async () => true,
    });
    expect(without).not.toContain('Remove');
    expect(without).toContain('Make main');
    expect(without).toMatch(/<button type="submit"[^>]*>Add<\/button>/);
  });

  it('keeps a channel that arrived after the reveal hidden, and offers the reveal again', () => {
    const out = card(new Map([[OTHER, 'nora@example.test']]));
    expect(out).toContain('Hidden');
    expect(out).not.toContain('+966');
    expect(out).toContain('Reveal contact details (this access is logged)');
  });
});

describe('New lead waits for an e-mail or phone (C7-UX-5)', () => {
  const card = (hasChannel: boolean) =>
    html(ContactLeadsCard, {
      leads: [],
      more: false,
      stages: STAGES,
      contactId: ID,
      canAddLead: true,
      confirmIsReveal: false,
      hasChannel,
      onNewLead: () => undefined,
      onChecked: () => undefined,
    });
  it('is disabled, and says why, for a contact with neither', () => {
    const out = card(false);
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>New lead<\/button>/);
    expect(out).toContain('Add an e-mail or phone first');
  });
  it('is offered for a contact with one', () => {
    const out = card(true);
    expect(out).toContain('>New lead</button>');
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*>New lead<\/button>/);
    expect(out).not.toContain('Add an e-mail or phone first');
  });
  it('the contact page tells the card whether there is one', () => {
    const source = readFileSync('src/components/admin/screens/contacts/ContactDetail.tsx', 'utf8');
    expect(source).toContain('hasChannel={channels.length > 0}');
  });
});

describe('revealed details are forgotten when the page is left (C7-PRIV-2)', () => {
  it('on pagehide, and on a return from the back/forward cache', () => {
    const target = new EventTarget();
    let forgot = 0;
    const stop = forgetOnLeave(target, () => (forgot += 1));
    target.dispatchEvent(new Event('pagehide'));
    expect(forgot).toBe(1);
    target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(forgot).toBe(2);
    // A first load is not a return.
    target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    expect(forgot).toBe(2);
    stop();
    target.dispatchEvent(new Event('pagehide'));
    expect(forgot).toBe(2);
  });
  it('the contact page clears its revealed values that way, before the page is frozen', () => {
    const source = readFileSync('src/components/admin/screens/contacts/ContactDetail.tsx', 'utf8');
    expect(source).toMatch(
      /forgetOnLeave\(window, \(\) => flushSync\(\(\) => setRevealed\(null\)\)\)/,
    );
  });
});

describe('the contact page keeps its figures current (C7-UX-3, C7-UX-4)', () => {
  it('a Details save is a toast', () => {
    const source = readFileSync(
      'src/components/admin/screens/contacts/ContactDetailsCard.tsx',
      'utf8',
    );
    expect(source).toMatch(/if \(await save\(patch\)\) toast\('Details saved\.', 'ok'\)/);
  });
  it('a note reads the contact again (last activity, kept until)', () => {
    const source = readFileSync('src/components/admin/screens/contacts/ContactDetail.tsx', 'utf8');
    const notes = source.slice(source.indexOf('<ContactNotes'), source.indexOf('<ContactTimeline'));
    expect(notes).toContain('queue.run(() => readContact(true))');
  });
  it('a star reads the counts again', () => {
    const source = readFileSync('src/components/admin/screens/contacts/ContactsList.tsx', 'utf8');
    const star = source.slice(
      source.indexOf('async function toggleStar'),
      source.indexOf('async function postBulk'),
    );
    expect(star).toContain('setRecount((n) => n + 1)');
  });
  it('the sub-line under a contact’s name is drawn in its own direction', () => {
    const page = readFileSync('src/pages/admin/contacts/[id].astro', 'utf8');
    expect(page).toContain("subtitleDir={subtitle ? 'auto' : undefined}");
    const island = readFileSync('src/components/admin/screens/contacts/ContactDetail.tsx', 'utf8');
    expect(island).toContain("sub.setAttribute('dir', 'auto')");
  });
});

describe('the add drawer’s rules', () => {
  const form = {
    name: ' Nora ',
    title: '',
    email: 'nora@example.test',
    phone: '',
    company: 'Acme',
    stage: 'lead' as const,
    owner: SARA,
    locale: 'ar' as const,
    city: '',
    source: 'referral' as const,
    tags: 'vip, expo, vip',
  };

  it('needs a name, and at most 10 tags', () => {
    expect(checkContact({ ...form, name: ' ' })).toEqual({ name: 'Give them a name.' });
    expect(
      checkContact({ ...form, tags: Array.from({ length: 11 }, (_, i) => `t${i}`).join(',') }).tags,
    ).toBeTruthy();
    expect(checkContact(form)).toEqual({});
  });

  it('sends what the API takes, empty boxes left out, each tag once', () => {
    const body = contactBody(form);
    expect(ContactCreateSchema.safeParse(body).success).toBe(true);
    expect(body.title).toBeUndefined();
    expect(body.tags).toEqual(['vip', 'expo']);
    expect(body.channels).toEqual([{ kind: 'email', value: 'nora@example.test', isPrimary: true }]);
    expect(tagsOf(' a , ,b ')).toEqual(['a', 'b']);
  });

  // C7 review, C7-COR-1 and C7-UX-2: a channel's issue is the n-th channel sent, by its kind.
  it('files a refused channel under its own box, in plain words', () => {
    const both = contactBody({ ...form, phone: '12' });
    expect(issueField('channels.1.value', 'String must contain at least 3', both)).toEqual({
      key: 'phone',
      message: 'Type the whole number, with its country code.',
    });
    expect(issueField('channels.0.value', 'Invalid email', both)).toEqual({
      key: 'email',
      message: 'Type the whole e-mail address, like name@example.com.',
    });
    const phoneOnly = contactBody({ ...form, email: '', phone: '12' });
    expect(issueField('channels.0.value', 'String must contain at least 3', phoneOnly)?.key).toBe(
      'phone',
    );
    expect(issueField('channels.4', 'x', phoneOnly)).toBeNull();
    expect(issueField('displayName', 'Required', both)).toEqual({
      key: 'name',
      message: 'Required',
    });
    expect(issueField('nope', 'x', both)).toBeNull();
  });
});

describe('the erasure needs a reason and a second press', () => {
  it('refuses without a reason, at either step', () => {
    expect(eraseStep('choose', '')).toEqual({
      next: 'choose',
      error: 'Choose why their data is erased.',
    });
    expect(eraseStep('confirm', '').next).toBe('choose');
  });
  it('asks again before it erases', () => {
    expect(eraseStep('choose', 'dsar')).toEqual({ next: 'confirm', error: '' });
    expect(eraseStep('confirm', 'decision')).toEqual({ next: 'erase', error: '' });
  });
  it('reads the preview with a POST and erases with the reason and the ticked matches', () => {
    const source = readFileSync(
      'src/components/admin/screens/contacts/EraseContactDialog.tsx',
      'utf8',
    );
    expect(source).toMatch(/erase-preview`,\s*\{\s*method: 'POST'/);
    expect(source).toContain(
      'body: { reason, ...(ticked.size > 0 ? { extraLeads: [...ticked] } : {}) }',
    );
  });
});

// Admin v2 C8b: the preview counts the tasks that go (C8: the person's own, `counts.tasks`; C8
// review, C8-SEC-4: each phone match's own, which the erasure takes only when it is ticked).
describe('the erasure says how many tasks go, ticks included (C8b)', () => {
  const preview: ErasePreview = {
    counts: { leads: 2, unindexed: 0, channels: 1, notes: 1, tasks: 3 },
    phoneMatches: [
      { id: OTHER, lead_number: 12, name: 'N.', company: null, created_at: null, tasks: 1 },
      { id: SARA, lead_number: 13, name: 'N.', company: null, created_at: null, tasks: 0 },
      { id: WON, lead_number: 14, name: 'N.', company: null, created_at: null, tasks: 2 },
    ],
  };
  it('the person’s own tasks, plus each ticked match’s', () => {
    expect(erasedTasks(preview, new Set())).toBe(3);
    expect(erasedTasks(preview, new Set([OTHER]))).toBe(4);
    expect(erasedTasks(preview, new Set([OTHER, SARA, WON]))).toBe(6);
    // A tick on something that is not a match adds nothing.
    expect(erasedTasks(preview, new Set([NEW]))).toBe(3);
  });
  it('says them in the preview’s line, in words', () => {
    expect(erasedLine(preview, new Set())).toBe('2 leads, 1 note, 3 tasks, 1 e-mail or phone.');
    expect(erasedLine(preview, new Set([WON]))).toBe(
      '2 leads, 1 note, 5 tasks, 1 e-mail or phone.',
    );
    const none = { counts: { ...preview.counts, tasks: 0 }, phoneMatches: [] };
    expect(erasedLine(none, new Set())).toBe('2 leads, 1 note, 0 tasks, 1 e-mail or phone.');
    const one = { counts: { ...preview.counts, leads: 1, tasks: 1 }, phoneMatches: [] };
    expect(erasedLine(one, new Set())).toBe('1 lead, 1 note, 1 task, 1 e-mail or phone.');
  });
  it('the dialog draws that line, follows the ticks, and names a match’s tasks', () => {
    const source = readFileSync(
      'src/components/admin/screens/contacts/EraseContactDialog.tsx',
      'utf8',
    );
    expect(source).toContain('<span dir="auto">{name}</span>: {erasedLine(preview, ticked)}');
    expect(source).toContain("{lead.tasks > 0 && `, with ${n(lead.tasks, 'task', 'tasks')}`}");
    expect(source).toContain('their leads, notes, tasks, e-mails and phone numbers');
  });
});

// Admin v2 C8b: the Tasks card on a contact's page, for crm.tasks holders, loaded once the page
// is up (C8 built it to take a contact; C7 built the page).
describe('a contact’s page carries the Tasks card (C8b)', () => {
  const island = readFileSync('src/components/admin/screens/contacts/ContactDetail.tsx', 'utf8');
  const page = readFileSync('src/pages/admin/contacts/[id].astro', 'utf8');
  it('loads it with import(), only when the page hands over the task owners', () => {
    expect(island).toMatch(/if \(!props\.tasks\) return;\s*import\('\.\.\/tasks\/TasksCard'\)/);
    const card = island.slice(
      island.lastIndexOf('<TasksCard'),
      island.indexOf('/>', island.lastIndexOf('<TasksCard')),
    );
    expect(island).toContain('{props.tasks && TasksCard && (');
    expect(card).toContain('contact={{');
    expect(card).toContain('id: contact.id');
    expect(card).toContain('owners={props.tasks.owners}');
  });
  it('reads the contact and its timeline again after a task changes', () => {
    const card = island.slice(
      island.lastIndexOf('<TasksCard'),
      island.indexOf('<section', island.lastIndexOf('<TasksCard')),
    );
    expect(card).toContain('queue.run(() => readContact(true))');
    expect(card).toContain('reloadEvents()');
  });
  it('the page hands the owners to crm.tasks holders only, and links tasks.css', () => {
    expect(page).toContain(
      "const canTasks = allowed && can(session.role, 'crm.tasks') === 'full';",
    );
    expect(page).toContain('canTasks ? readTaskOwners(sb, session) : Promise.resolve([])');
    // The card itself is handed over only under the same rule (the C78 check: without this line
    // a role with crm.contacts but not crm.tasks would be drawn a card its routes then refuse).
    expect(page).toContain('if (canTasks) tasks = { owners };');
    expect(page).not.toMatch(/^\s*tasks = \{ owners \};/m);
    expect(page).toContain('tasks={tasks}');
    expect(page).toContain("styles={['leads.css', 'contacts.css', 'tasks.css']}");
  });
});

describe('Details sends what changed', () => {
  const before = {
    display_name: 'Nora',
    title: 'Designer',
    company_name: 'Acme',
    city: '',
    country: '',
    locale: 'en',
    source: 'manual',
  };
  it('nothing changed is nothing to save', () => {
    expect(detailsPatch(before, { ...before }, [])).toBeNull();
  });
  it('an emptied box is null, a changed one its words', () => {
    const patch = detailsPatch(before, { ...before, title: '', city: ' Riyadh ' }, []);
    expect(patch).toEqual({ title: null, city: 'Riyadh' });
    expect(ContactPatchSchema.safeParse({ ...patch, version: 2 }).success).toBe(true);
  });
});

describe('the address', () => {
  it('reads only what it knows, and never a search or a tag', () => {
    const params = new URLSearchParams(
      'stage=client&owner=me&sort=name&page=2&q=nora@x.test&tag=vip&x=1',
    );
    const filters = parseContactFilters(params);
    expect(filters).toEqual({ chip: 'client', owner: 'me', sort: 'name', page: 2 });
    const href = withContactFilters('/admin/contacts', filters);
    expect(href).toBe('/admin/contacts?stage=client&owner=me&sort=name&page=2');
    expect(href).not.toMatch(/q=|tag=|@/);
    expect(parseContactFilters(new URLSearchParams('stage=spam&owner=nobody&page=-1'))).toEqual(
      DEFAULT_CONTACT_FILTERS,
    );
  });
  it('builds bodies the API takes, the search and the tag only from the island', () => {
    for (const chip of ['all', 'lead', 'partner', 'starred', 'expiring'] as const) {
      const body = contactQueryOf(
        { ...DEFAULT_CONTACT_FILTERS, chip, owner: 'none' },
        { q: 'Nora', tag: 'vip' },
      );
      expect(ContactQuerySchema.safeParse(body).success, chip).toBe(true);
    }
    expect(contactQueryOf({ ...DEFAULT_CONTACT_FILTERS, chip: 'starred' })).toEqual({
      sort: 'recent',
      limit: 20,
      offset: 0,
      starred: true,
    });
  });
});

describe('the words', () => {
  it('adds months as Postgres does, the day held to the month’s last', () => {
    expect(addMonths('2026-01-31T10:00:00.000Z', 1)).toBe('2026-02-28T10:00:00.000Z');
    expect(addMonths('2026-03-15T00:00:00.000Z', 24)).toBe('2028-03-15T00:00:00.000Z');
    expect(addMonths('nonsense', 1)).toBeNull();
  });
  it('the sub-lines', () => {
    expect(contactsSubline(SUMMARY)).toBe('12 people · 3 clients · 8 leads · 1 past client');
    expect(roleLine('Designer', 'Acme')).toBe('Designer at Acme');
    expect(roleLine('', 'Acme')).toBe('At Acme');
    expect(tagsShown(['a', 'b'])).toEqual({ tags: ['a', 'b'], more: 0 });
  });
  it('a timeline row is a sentence of metadata, a lead’s named by its number', () => {
    const people = new Map([[SARA, 'Sara']]);
    const stages = new Map([
      ['new', { label: 'New' }],
      ['won', { label: 'Won' }],
    ]);
    const event = (over: Partial<ContactEvent>): ContactEvent => ({
      src: 'contact',
      id: 1,
      at: NOW,
      actor_id: SARA,
      kind: 'created',
      detail: {},
      lead_id: null,
      lead_number: null,
      ...over,
    });
    expect(
      contactEventSentence(
        event({ kind: 'stage_changed', detail: { from: 'lead', to: 'client' } }),
        stages,
        people,
      ),
    ).toBe('Stage changed from Lead to Client');
    expect(
      contactEventSentence(
        event({ kind: 'details_changed', detail: { fields: ['display_name', 'city'] } }),
        stages,
        people,
      ),
    ).toBe('Changed the name, city');
    expect(
      contactEventSentence(
        event({ kind: 'lead_linked', detail: { lead_number: 7, by: 'phone' } }),
        stages,
        people,
      ),
    ).toBe('Lead #7 linked by phone number');
    expect(
      contactEventSentence(
        event({ kind: 'channel_added', detail: { kind: 'email', source: 'manual' } }),
        stages,
        people,
      ),
    ).toBe('E-mail address added');
    expect(
      contactEventSentence(
        event({
          src: 'lead',
          kind: 'stage_changed',
          lead_number: 12,
          detail: { from: 'new', to: 'won' },
        }),
        stages,
        people,
      ),
    ).toBe('Lead #12: Moved from New to Won');
  });
  it('a phone match counts toward neither the score nor the value', () => {
    const lead = (over: Partial<ContactLead>): ContactLead => ({
      id: ID,
      lead_number: 1,
      name: null,
      company: null,
      stage_id: WON,
      is_spam: false,
      score: 40,
      value_sar: 100,
      created_at: NOW,
      contact_link: 'email',
      source: 'web_form',
      ...over,
    });
    expect(
      leadTotals(
        [lead({}), lead({ score: 99, value_sar: 900, contact_link: 'phone' })],
        new Set([WON]),
      ),
    ).toEqual({ score: 40, value: 100 });
    expect(leadTotals([], new Set())).toEqual({ score: null, value: 0 });
  });
  it('a confirmed match says what it could not copy', () => {
    expect(copiedWords({ link: 'staff', email: 'added', phone: 'kept' })).toBe('');
    expect(copiedWords({ link: 'staff', email: 'elsewhere', phone: 'full' })).toContain(
      'another contact',
    );
  });
});

describe('the palette’s contacts', () => {
  it('knows an address or a number when it sees one, however the number is written', () => {
    for (const term of [
      'nora@example.test',
      'nora@',
      '+966 55 123 4567',
      '0551234567',
      '٠٥٥١٢٣٤٥٦٧',
      '050/123/4567',
      '+966501234567 mobile',
    ]) {
      expect(looksLikeContactDetail(term), term).toBe(true);
    }
    for (const term of ['Nora', 'Acme 2026', '12345', 'services']) {
      expect(looksLikeContactDetail(term), term).toBe(false);
    }
  });
  it('lists a name and a company, linked by id', () => {
    expect(contactGroup([{ id: ID, display_name: 'Nora', company_name: 'Acme' }])).toEqual([
      {
        title: 'Contacts',
        items: [
          {
            key: `c:${ID}`,
            label: 'Nora',
            href: `/admin/contacts/${ID}`,
            icon: 'users',
            detail: 'Acme',
            dir: 'auto',
          },
        ],
      },
    ]);
    expect(contactGroup([])).toEqual([]);
  });
  // C7 review, C7-SEC-1: the palette asks at every pause in typing, so whatever is in the box
  // then (half an address, the first digits of a number) must never go in a URL.
  it('searches records with a POST, the term in its body, never in a URL', () => {
    expect(searchRequest('  nora.haddad ')).toEqual({
      url: '/api/admin/search',
      init: { method: 'POST', body: { q: 'nora.haddad' } },
    });
    const source = readFileSync('src/components/admin/screens/chrome/CommandPalette.tsx', 'utf8');
    expect(source).toContain('searchRequest(q)');
    expect(source).not.toMatch(/api\/admin\/search\?/);
    expect(source).not.toContain('encodeURIComponent(q)');
    expect(source).toMatch(
      /'\/api\/admin\/crm\/contacts\/lookup', \{\s*method: 'POST',\s*body: \{ q \}/,
    );
    // "See all results" (a link the person picks) is left out for an address or a number.
    expect(source).toContain('!looksLikeContactDetail(query)');
  });

  // C7 review, C7-I18N-1 and C7-UX-1: a person's name and company in their own direction.
  it('draws an option’s label and detail in the direction the item asks', () => {
    const out = html(CommandPalette, {
      groups: [
        {
          title: 'Contacts',
          items: [
            {
              key: `c:${ID}`,
              label: 'نورة',
              href: `/admin/contacts/${ID}`,
              icon: 'users',
              detail: 'شركة',
              dir: 'auto',
            },
            { key: 's', label: 'Services', href: '/admin/services', icon: 'pages' },
          ],
        },
      ],
      contacts: true,
    });
    expect(out).toContain('<span dir="auto">نورة</span>');
    expect(out).toContain('<i dir="auto">شركة</i>');
    expect(out).toContain('<span>Services</span>');
  });

  // C7 review, C7-COPY-1: services are still searched for a contacts holder.
  it('names every area it searches in its placeholder', () => {
    expect(html(CommandPalette, { groups: [], contacts: true })).toContain(
      'placeholder="Search pages, services, projects, people…"',
    );
    expect(html(CommandPalette, { groups: [] })).toContain(
      'placeholder="Search pages, services, projects…"',
    );
  });
});
