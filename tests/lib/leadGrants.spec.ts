import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  GATED_LEAD_COLUMNS,
  LEAD_WRITE_COLUMNS,
  SAFE_LEAD_COLUMNS,
  SENSITIVE_LEAD_COLUMNS,
} from '@/lib/admin/leadFields';
import { leadPatchValues } from '@/lib/crm/leadWrite';
import { replayLeadGrant } from './leadGrantReplay';

// Migration 0033: staff tokens read leads through a COLUMN grant. Two things must stay
// true as both sides change:
//   1. The caller's client can read every column the admin selects through it
//      (SAFE_LEAD_COLUMNS). A column missing from the grant fails the whole query, and the
//      lead list, the detail and the dashboard count come back as errors.
//   2. No gated column is ever granted. Those are read as the service role, by the
//      audited paths only, and this file names which files those are.

describe('the leads SELECT grant (0033)', () => {
  const granted = replayLeadGrant('select');

  it('is a column grant, never table-wide', () => {
    expect(granted.has('*')).toBe(false);
    expect(granted.size).toBeGreaterThan(5);
  });

  it("covers every column the admin reads through the caller's client", () => {
    for (const column of SAFE_LEAD_COLUMNS.split(',')) expect(granted, column).toContain(column);
    // What a lead write answers with (Admin v2 C3): the safe and pipeline columns.
    for (const column of LEAD_WRITE_COLUMNS.split(',')) expect(granted, column).toContain(column);
    // The tenant predicate every admin query adds (crud.ts getRow/listRows, the counts).
    expect(granted).toContain('tenant_id');
  });

  it('grants no gated column, ciphertext, retention date or CRM-internal column', () => {
    const forbidden = [
      ...GATED_LEAD_COLUMNS.split(','),
      ...SENSITIVE_LEAD_COLUMNS,
      'retention_delete_after',
      // What the CRM keeps from staff tokens: the saved spam horizon (0034), the blind
      // indexes, the score's reasons (two derive from budget and timeline) and the index
      // cursor (0035).
      'retention_before_spam',
      'email_hmac',
      'phone_hmac',
      'score_signals',
      'crm_indexed_at',
    ];
    for (const column of forbidden) expect(granted, column).not.toContain(column);
  });
});

describe('the leads UPDATE grant (0030, 0041)', () => {
  const granted = replayLeadGrant('update');

  it('is a column grant, never table-wide', () => {
    expect(granted.has('*')).toBe(false);
  });

  it('covers every column the PATCH route writes, and nothing the CRM keeps to itself', () => {
    // Every field a PATCH can send, so leadPatchValues names every column it can write.
    const written = Object.keys(
      leadPatchValues(
        {
          version: 1,
          stageId: 'x',
          isSpam: true,
          assignedTo: null,
          valueSar: 1,
          tags: [],
          isStarred: true,
          read: true,
          logContact: { channel: 'call' },
          status: 'new',
          internalNotes: 'x',
        },
        new Date(),
      ),
    );
    for (const column of written) expect(granted, column).toContain(column);
    expect([...granted].sort()).toEqual([...written].sort());
    for (const column of [
      ...GATED_LEAD_COLUMNS.split(',').filter((c) => c !== 'internal_notes'),
      'retention_delete_after',
      'retention_before_spam',
      'read_by',
      'score',
      'score_signals',
      'email_hmac',
      'phone_hmac',
      'version',
      'lead_number',
      'tenant_id',
    ]) {
      expect(granted, column).not.toContain(column);
    }
  });
});

// ── Who reads gated lead columns ──────────────────────────────────────────────────────

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|astro)$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(process.cwd(), path).replace(/\\/g, '/'),
  code: readFileSync(path, 'utf8'),
}));

describe('gated lead columns have a short, named list of readers', () => {
  it('only the reveal and the export use the gated projections', () => {
    const users = files
      .filter((f) => /\b(GATED_LEAD_COLUMNS|FULL_LEAD_COLUMNS)\b/.test(f.code))
      .map((f) => f.path)
      .sort();
    expect(users).toEqual([
      'src/lib/admin/leadFields.ts',
      // The one reveal path, for the legacy ?pii=1 and the CRM's POST /reveal (C2b).
      'src/lib/crm/reveal.ts',
      'src/pages/api/admin/leads/export.ts',
    ]);
  });

  it('only these files touch leads as the service role', () => {
    const readers = files
      .filter((f) => /from\(\s*['"]leads['"]\s*\)/.test(f.code) && /\bserviceClient\b/.test(f.code))
      .map((f) => f.path)
      .sort();
    expect(readers).toEqual([
      // The reveal: after assertCap, a live recheck, the limiter and a fail-closed audit.
      'src/lib/crm/reveal.ts',
      // The public form's insert (service role, tenant resolved server-side).
      'src/lib/data/leads.ts',
      // The export: the §3 lockdown.
      'src/pages/api/admin/leads/export.ts',
      // The notification hook: a signed call, re-fetches the row, filters by recipient role.
      'src/pages/api/hooks/notify-lead.ts',
    ]);
  });

  // lead_notes is service-role only (0034); this route is the Worker's one door to the
  // thread, for reading (an audit row first) and for adding (C2b). The legacy
  // internal_notes mirror is kept by a definer trigger, not by Worker code.
  it('only the notes route touches the notes thread', () => {
    const doors = files
      .filter((f) => /from\(\s*['"]lead_notes['"]\s*\)/.test(f.code))
      .map((f) => f.path)
      .sort();
    expect(doors).toEqual(['src/pages/api/admin/leads/[id]/notes.ts']);
  });

  // The check above sees a file that builds its own service client. A module handed one
  // (the daily cron's) needs this second net: `budget_enc` exists only on leads, so a file
  // naming it is handling lead ciphertext.
  it('only these files handle the lead ciphertext', () => {
    const handlers = files
      .filter((f) => /\bbudget_enc\b/.test(f.code))
      .map((f) => f.path)
      .sort();
    expect(handlers).toEqual([
      'src/lib/admin/leadFields.ts',
      // The daily cron's indexing (C1b): decrypts in the Worker, computes indexes and
      // signals, writes them through crm_index_lead. No person sees the values.
      'src/lib/crm/indexBackfill.ts',
      'src/lib/crm/reveal.ts',
      'src/lib/data/leads.ts',
      'src/pages/api/admin/leads/export.ts',
      'src/pages/api/hooks/notify-lead.ts',
    ]);
  });
});

// ── The service role's lead doors (0035, 0041) ─────────────────────────────────────────
// No API role inserts or deletes a lead, or touches the notes thread, so those writes go
// through service-role RPCs. Each has a short list of callers, every one behind assertCap
// (or, for ingest, the public form's server-side checks) and, where a person acts, a live
// recheck and an audit row.
describe('the service-role lead RPCs have named callers', () => {
  const callers = (fn: string) =>
    files
      .filter((f) => new RegExp(`rpc\\(\\s*['"]${fn}['"]`).test(f.code))
      .map((f) => f.path)
      .sort();

  it('crm_ingest_lead: the public form and a lead added by hand, both in data/leads.ts', () => {
    expect(callers('crm_ingest_lead')).toEqual(['src/lib/data/leads.ts']);
  });
  it('crm_erase_lead: the erase route only (crm.erase, live recheck, audited first)', () => {
    expect(callers('crm_erase_lead')).toEqual(['src/pages/api/admin/leads/[id]/erase.ts']);
  });
  it('crm_delete_lead_note: the note route only (crm.erase, live recheck, audited first)', () => {
    expect(callers('crm_delete_lead_note')).toEqual([
      'src/pages/api/admin/leads/[id]/notes/[noteId].ts',
    ]);
  });
  it('crm_lead_note_counts: the export only (the §3 lockdown)', () => {
    expect(callers('crm_lead_note_counts')).toEqual(['src/pages/api/admin/leads/export.ts']);
  });
});
