import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APPLICATION_STATUSES, SPAM_RETENTION_DAYS } from '@schemas/application';
import { BADGE_TONES } from '@/lib/admin/tones';
import {
  APPLICATION_STATUS_LABEL,
  APPLICATION_STATUS_TONE,
  detailRows,
  formatBytes,
  isRevealed,
  mergeAfterPatch,
  parseInitial,
  safeLink,
  statusChips,
  statusLabel,
  withoutContact,
  type ApplicationDetail,
} from '@/lib/admin/applicationView';
import { applications } from '@/lib/admin/notifications/applications';
import ApplicationDrawer, {
  LEAVE_MESSAGE,
  SPAM_MESSAGE,
  eraseMessage,
} from '@/components/admin/screens/applications/ApplicationDrawer';
import ApplicationsPanel from '@/components/admin/screens/applications/ApplicationsPanel';

// Job applications on the kit (Admin v2 U8a): the screen's model, and what the panel and the
// drawer may and may not ask the server for. The routes themselves are unchanged and pinned
// in tests/lib/applicationsAdmin.spec.ts (the audited reveal, the live recheck, the CV
// download, the erase order).

const DETAIL: ApplicationDetail = {
  id: '0b0b0b0b-0000-4000-8000-000000000001',
  created_at: '2026-10-10T09:05:00.000Z',
  locale: 'ar',
  name: 'ريم',
  city: 'Riyadh',
  role: 'Motion designer',
  experience: '3-6',
  work_type: 'full-time',
  availability: 'month',
  skills: ['animation'],
  portfolio_url: 'https://example.com/reem',
  linkedin_url: null,
  status: 'new',
  future_roles_consent: true,
  retention_delete_after: '2028-10-10T09:05:00.000Z',
  has_cv: true,
  cv_content_type: 'application/pdf',
  cv_bytes: 2048,
  message: 'مرحبا',
  internal_notes: null,
  consent_at: '2026-10-10T09:05:00.000Z',
  consent_version: '2026-09-30',
};

const DASHES = /[–—]/;

describe('the statuses', () => {
  it('a label and a tone for exactly the Join schema’s statuses, in words, no dash', () => {
    expect(Object.keys(APPLICATION_STATUS_LABEL).sort()).toEqual([...APPLICATION_STATUSES].sort());
    expect(Object.keys(APPLICATION_STATUS_TONE).sort()).toEqual([...APPLICATION_STATUSES].sort());
    for (const status of APPLICATION_STATUSES) {
      expect(APPLICATION_STATUS_LABEL[status]).not.toMatch(/_|[–—]/);
      expect(BADGE_TONES).toContain(APPLICATION_STATUS_TONE[status]);
    }
    expect(statusLabel('in_review')).toBe('In review');
    expect(statusLabel('archived-by-hand')).toBe('archived-by-hand');
  });

  it('the filter is All, then every status in order', () => {
    expect(statusChips().map((c) => c.value)).toEqual(['all', ...APPLICATION_STATUSES]);
    for (const chip of statusChips()) expect(chip.label).not.toMatch(DASHES);
  });
});

describe('the details card', () => {
  it('labels from the option tables, the language in words, never a contact field', () => {
    const revealed: ApplicationDetail = {
      ...DETAIL,
      email: 'r@example.com',
      phone: '+966500000000',
    };
    const rows = detailRows(revealed);
    expect(rows.map(([label]) => label)).toEqual([
      'Role',
      'City',
      'Experience',
      'Works',
      'Can start',
      'Language',
      'Received',
    ]);
    expect(Object.fromEntries(rows)).toMatchObject({
      Experience: '3 to 6 years',
      Works: 'Full-time',
      'Can start': 'Within a month',
      Language: 'Arabic',
      Received: '10 Oct 2026, 12:05',
    });
    const text = JSON.stringify(rows);
    expect(text).not.toContain('r@example.com');
    expect(text).not.toContain('+966500000000');
    for (const [label, value] of rows) expect(`${label} ${value}`).not.toMatch(DASHES);
  });
});

describe('a save after a reveal keeps what was revealed', () => {
  const revealed: ApplicationDetail = { ...DETAIL, email: 'r@example.com', phone: null };

  it('takes the new status, notes and retention, keeps the e-mail and phone', () => {
    const next = mergeAfterPatch(revealed, {
      status: 'spam',
      internal_notes: 'Checked',
      retention_delete_after: '2026-11-09T09:05:00.000Z',
    });
    expect(next).toMatchObject({
      status: 'spam',
      internal_notes: 'Checked',
      retention_delete_after: '2026-11-09T09:05:00.000Z',
      email: 'r@example.com',
      phone: null,
    });
    expect(isRevealed(next)).toBe(true);
  });

  it('an answer can never put contact details in, nor take them out', () => {
    const answer = { status: 'hired', email: 'other@example.com' } as Partial<ApplicationDetail>;
    expect(mergeAfterPatch(revealed, answer).email).toBe('r@example.com');
    const hidden = mergeAfterPatch(DETAIL, answer);
    expect('email' in hidden).toBe(false);
    expect(isRevealed(hidden)).toBe(false);
  });

  it('"Hide" drops them from memory', () => {
    const hidden = withoutContact(revealed);
    expect('email' in hidden || 'phone' in hidden).toBe(false);
    expect(isRevealed(hidden)).toBe(false);
  });
});

describe('the address', () => {
  it('a known status and a uuid; anything else is ignored', () => {
    expect(parseInitial({ status: 'in_review', open: DETAIL.id })).toEqual({
      status: 'in_review',
      open: DETAIL.id,
    });
    expect(parseInitial({ status: 'IN_REVIEW', open: 'a-1' })).toEqual({
      status: null,
      open: null,
    });
    expect(parseInitial({ status: '<script>', open: `${DETAIL.id}"><x` })).toEqual({
      status: null,
      open: null,
    });
    expect(parseInitial({ status: null, open: null })).toEqual({ status: null, open: null });
    expect(parseInitial({ open: DETAIL.id.toUpperCase() }).open).toBe(DETAIL.id);
  });

  it('the bell links to the application it names', async () => {
    const sb = {
      from: () => {
        const q = {
          select: () => q,
          eq: () => q,
          neq: () => q,
          gte: () => q,
          order: () => q,
          limit: async () => ({
            data: [{ id: DETAIL.id, role: 'Motion designer', created_at: DETAIL.created_at }],
            error: null,
          }),
        };
        return q;
      },
    };
    const items = await applications.load({
      sb: sb as never,
      auth: { tenantId: 't' } as never,
      now: new Date('2026-10-10T12:00:00Z'),
    } as never);
    expect(items[0]?.href).toBe(`/admin/applications?open=${DETAIL.id}`);
  });
});

describe('the helpers the panel kept', () => {
  it('formats sizes and only links https', () => {
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(0)).toBe('');
    expect(safeLink('https://behance.net/x')).toBe('https://behance.net/x');
    expect(safeLink('javascript:alert(1)')).toBeNull();
  });
});

describe('the words that ask first', () => {
  it('spam names its 30 days; erase names the person inside an isolate; no dash', () => {
    expect(SPAM_MESSAGE).toBe(
      `Mark as spam? It will be deleted within ${SPAM_RETENTION_DAYS} days.`,
    );
    expect(eraseMessage('ريم')).toBe('Erase ⁨ريم⁩’s application and CV? This cannot be undone.');
    for (const words of [SPAM_MESSAGE, LEAVE_MESSAGE, eraseMessage('x')]) {
      expect(words).not.toMatch(DASHES);
    }
  });
});

describe('the panel and the drawer (source and server render)', () => {
  const panel = readFileSync(
    'src/components/admin/screens/applications/ApplicationsPanel.tsx',
    'utf8',
  );
  const drawer = readFileSync(
    'src/components/admin/screens/applications/ApplicationDrawer.tsx',
    'utf8',
  );

  // The code alone: the comments explain the reveal and name `?pii=1` on purpose.
  const code = (source: string) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');

  it('never call window.confirm, and ask for ?pii=1 only in the reveal handler', () => {
    for (const source of [panel, drawer]) expect(code(source)).not.toMatch(/window\.confirm/);
    expect(code(panel)).not.toContain('pii=1');
    expect(code(drawer).match(/pii=1/g)).toHaveLength(1);
    const reveal = drawer.slice(drawer.indexOf('async function reveal()'));
    const END = '\n  }\n';
    expect(reveal.slice(0, reveal.indexOf(END))).toContain('?pii=1');
    // The save path sends one PATCH and takes its answer; it never re-opens the application.
    const patch = drawer.slice(drawer.indexOf('async function patch('));
    const patchBody = code(patch.slice(0, patch.indexOf(END)));
    expect(patchBody).toContain('mergeAfterPatch');
    expect(patchBody.match(/adminFetch/g)).toHaveLength(1);
    expect(patchBody).toContain("method: 'PATCH'");
  });

  it('render with no style attribute, no em or en dash, and every applicant text dir="auto"', () => {
    const list = renderToStaticMarkup(createElement(ApplicationsPanel, { canSeePii: true }));
    expect(list).toContain('Filter by status');
    expect(list).toContain('Job applications');
    expect(list).not.toMatch(/\sstyle=/);
    expect(list).not.toMatch(DASHES);
    const closed = renderToStaticMarkup(
      createElement(ApplicationDrawer, {
        id: null,
        canSeePii: true,
        onClose: () => undefined,
        onChanged: () => undefined,
        onErased: () => undefined,
      }),
    );
    expect(closed).toContain('<dialog class="drw" data-size="wide"');
    expect(closed).not.toMatch(/\sstyle=/);
    expect(drawer).toMatch(/className="prewrap app-drawer__message" dir="auto"/);
    expect(panel).toMatch(/<span dir="auto">\{row\.name\}<\/span>/);
    expect(drawer).not.toMatch(DASHES);
    expect(panel).not.toMatch(DASHES);
  });
});
