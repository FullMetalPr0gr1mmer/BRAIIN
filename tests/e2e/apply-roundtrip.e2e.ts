import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/*
 * Join — one REAL application, end to end (owner decisions J1/J2, CLAUDE.md §3 "Applicant
 * PII"): the Worker's /api/apply → the private Supabase Storage bucket `applications` →
 * the Admin-only `job_applications` row. The unit suites (tests/api/apply.spec.ts,
 * tests/lib/fileSniff.spec.ts) cover every refusal; this file proves the parts no stub
 * can: the bucket accepts the sniffed type, the object lands at a random path, the e-mail
 * is stored as ciphertext, and neither the row nor the file is reachable with the anon key.
 *
 * Needs the perf-seo-a11y e2e job's environment: the seeded local Supabase WITH storage-api
 * running (that job's SUPABASE_EXCLUDE keeps it), applications open (the published seed sets
 * `accepting_applications`), and the local keys exported by the workflow. Anywhere else —
 * above all a preview pointed at a remote project — it skips rather than file a real
 * application somewhere it should not.
 *
 * Budget: the endpoint allows 5 applications per IP per hour (fails closed). This file
 * sends ONE that counts (two with the CI retry); the page suite mocks the endpoint.
 */

const SUPABASE_URL = process.env['PUBLIC_SUPABASE_URL'] ?? '';
const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const ANON_KEY = process.env['PUBLIC_SUPABASE_ANON_KEY'] ?? '';
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(SUPABASE_URL.replace(/\/$/, ''));

const CV_PATH_SHAPE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/;
const PHONE = '+966 50 000 0000';

// The smallest file the head/tail check accepts: `%PDF-` first, `%%EOF` in the last KB.
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'latin1');

function applicationForm(name: string, email: string): FormData {
  const form = new FormData();
  const fields: [string, string][] = [
    ['locale', 'en'],
    ['name', name],
    ['email', email],
    ['phone', PHONE],
    ['city', 'Riyadh'],
    ['role', 'Motion designer'],
    ['experience', '3-6'],
    ['work_type', 'full-time'],
    ['availability', 'month'],
    ['skills', 'motion-graphics'],
    ['skills', 'animation'],
    ['portfolio', 'https://example.com/portfolio'],
    ['message', 'An end-to-end test application. Safe to erase.'],
    ['consent_application', 'on'],
    ['policy_version', '2026-09-30'],
    ['hp', ''],
  ];
  for (const [key, value] of fields) form.append(key, value);
  form.append('cv', new Blob([PDF], { type: 'application/pdf' }), 'my cv (final).pdf');
  return form;
}

test.describe('a real application, end to end', () => {
  // In order, in one worker: one client, one clean-up, and the budget counted once.
  test.describe.configure({ mode: 'default' });
  test.skip(
    !LOCAL || !SERVICE_KEY || !ANON_KEY,
    'needs the e2e job: a LOCAL seeded Supabase with storage, and its keys in the environment',
  );

  let svc: SupabaseClient;

  test.beforeAll(() => {
    svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  });

  test.afterAll(async () => {
    // Erase every test application (a retry's too — the admin's DSAR order: the objects,
    // then the rows), and the limiter's counters, so a local re-run starts from the same
    // budget. Local databases only (the skip above).
    const { data } = await svc.from('job_applications').select('id,cv_path').like('name', 'E2E %');
    const rows = (data ?? []) as { id: string; cv_path: string | null }[];
    const paths = rows.map((r) => r.cv_path).filter((p): p is string => typeof p === 'string');
    if (paths.length > 0) await svc.storage.from('applications').remove(paths);
    if (rows.length > 0) {
      await svc
        .from('job_applications')
        .delete()
        .in(
          'id',
          rows.map((r) => r.id),
        );
    }
    await svc.from('public_write_attempts').delete().like('scope', 'apply:%');
  });

  test('the form is reported open, never from a cache', async ({ request }) => {
    const res = await request.get('/api/apply/status');
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toContain('no-store');
    expect(await res.json()).toEqual({ open: true });
  });

  test('a cross-origin post is refused before anything is read or counted', async ({ request }) => {
    const res = await request.post('/api/apply', {
      multipart: applicationForm('E2E cross-origin', 'e2e-cross@example.com'),
      headers: { origin: 'https://attacker.example', accept: 'application/json' },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(403);
    const { data } = await svc.from('job_applications').select('id').eq('name', 'E2E cross-origin');
    expect(data ?? []).toHaveLength(0);
  });

  test('stores the CV privately and the contact details as ciphertext', async ({
    request,
    baseURL,
  }) => {
    const run = randomUUID().slice(0, 8);
    const name = `E2E Applicant ${run}`;
    const email = `e2e-${run}@example.com`;

    const res = await request.post('/api/apply', {
      multipart: applicationForm(name, email),
      headers: {
        origin: new URL(baseURL ?? 'http://localhost:8788').origin,
        accept: 'application/json',
      },
      maxRedirects: 0,
    });
    expect(res.headers()['cache-control']).toContain('no-store');
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.status()).toBe(200);

    // The row: Admin-only table, read here with the service role.
    const { data: rows, error } = await svc
      .from('job_applications')
      .select(
        'id,email_enc,phone_enc,cv_path,cv_content_type,cv_bytes,skills,status,' +
          'future_roles_consent,consent_version,consent_at,retention_delete_after,created_at',
      )
      .eq('name', name);
    expect(error).toBeNull();
    expect(rows).toHaveLength(1);
    const row = rows![0] as unknown as Record<string, unknown>;
    const id = row['id'] as string;
    const path = row['cv_path'] as string;

    expect(String(row['email_enc'])).not.toContain(email);
    expect(String(row['email_enc'])).not.toContain('@');
    expect(String(row['phone_enc'])).not.toContain(PHONE);
    // The stored path is random, never the uploaded file's name.
    expect(path).toMatch(CV_PATH_SHAPE);
    expect(path).not.toContain('final');
    expect(row['cv_content_type']).toBe('application/pdf');
    expect(row['cv_bytes']).toBe(PDF.length);
    expect(row['skills']).toEqual(['motion-graphics', 'animation']);
    expect(row['status']).toBe('new');
    expect(row['future_roles_consent']).toBe(false);
    expect(row['consent_version']).toBe('2026-09-30');
    // 12 months without the future-roles consent (J4) — within a day of a year from now.
    const keep = new Date(row['retention_delete_after'] as string).getTime();
    const created = new Date(row['created_at'] as string).getTime();
    expect(Math.abs(keep - created - 365 * 86_400_000)).toBeLessThan(2 * 86_400_000);

    // The object: exactly the uploaded bytes, under the sniffed type.
    const { data: file, error: dlError } = await svc.storage.from('applications').download(path);
    expect(dlError).toBeNull();
    expect(Buffer.from(await file!.arrayBuffer()).equals(PDF)).toBe(true);

    // Nothing of it is reachable with the anon key: not the row, not the file, not by its
    // public URL, and the bucket refuses an anon write.
    const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    const anonRow = await anon.from('job_applications').select('id').eq('id', id);
    expect(anonRow.error).not.toBeNull();
    expect(anonRow.data ?? []).toHaveLength(0);
    const anonFile = await anon.storage.from('applications').download(path);
    expect(anonFile.data).toBeNull();
    const publicUrl = anon.storage.from('applications').getPublicUrl(path).data.publicUrl;
    expect((await request.get(publicUrl)).status()).not.toBe(200);
    const intruder = `${path.split('/')[0]}/intruder.pdf`;
    const anonWrite = await anon.storage
      .from('applications')
      .upload(intruder, new Blob([PDF], { type: 'application/pdf' }));
    if (!anonWrite.error) await svc.storage.from('applications').remove([intruder]);
    expect(anonWrite.error).not.toBeNull();
  });

  test('the daily sweep finds a CV no row names — and never one a row does', async () => {
    // An orphan, as a Worker stopped between upload and insert would leave it.
    const orphan = `e2e-orphan/${randomUUID()}.pdf`;
    const up = await svc.storage
      .from('applications')
      .upload(orphan, new Blob([PDF], { type: 'application/pdf' }), {
        contentType: 'application/pdf',
      });
    expect(up.error).toBeNull();
    try {
      // Grace 0 here; the cron passes an hour (ORPHAN_GRACE_MINUTES).
      const { data, error } = await svc.rpc('application_orphan_cvs', {
        p_older_than_minutes: 0,
        p_limit: 1000,
      });
      expect(error).toBeNull();
      const found = ((data ?? []) as { object_name: string }[]).map((o) => o.object_name);
      expect(found).toContain(orphan);
      const { data: rows } = await svc
        .from('job_applications')
        .select('cv_path')
        .not('cv_path', 'is', null);
      for (const r of (rows ?? []) as { cv_path: string }[]) {
        expect(found, 'a CV its row still names is never an orphan').not.toContain(r.cv_path);
      }
    } finally {
      await svc.storage.from('applications').remove([orphan]);
    }
  });
});
