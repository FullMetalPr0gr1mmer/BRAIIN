// The Join application form (src/components/ApplicationForm.astro) — an enhancement over a
// form that already works with no script at all: a multipart POST to /api/apply, answered
// with a 303 to /join?status=<status>#apply, whose status the page renders server-side.
// With script:
//   • /api/apply/status is asked whether applications are open. Closed shows the notice —
//     in the space the band's lead line already holds, so nothing moves (no layout shift
//     after first paint) — and disables the send button. No answer leaves the form as served
//     (the endpoint is the gate either way: it answers `closed`).
//   • the checks mirror ApplicationInputSchema before the round trip — required, email, an
//     https link, the lengths, the CV's type (.pdf / .docx) and size (≤ 10 MB), the required
//     consent — and name each problem in words (formErrors.ts). The server stays the gate.
//   • the CV dropzone takes a dropped file, names the chosen one with its size, and its
//     Remove button sits outside the label (a click on it never reopens the picker). Every
//     state change swaps text within boxes the server already sized: no shift.
//   • the submission is fetch + FormData with `Accept: application/json`; the ONE status
//     region reports the real answer, and a 422 marks the fields the server named.
//
// Zod-free on purpose, like formErrors.ts: packages/schemas/application.ts builds its schemas
// at module scope, so importing even one constant from it bundles zod into the public page
// (a probe bundle importing applicationKeyToField alone came out at 75 KB minified). The
// few contract values the browser needs are mirrored here and held equal to the schema
// module by tests/lib/applicationForm.spec.ts. Never builds markup from strings.

import {
  applyStatusFromHttp,
  checkForm,
  clearErrorsOnInput,
  clearFieldError,
  markFieldError,
  outcomeOf,
  showFieldErrors,
  showStatus,
  type FieldProblem,
  type FormOutcome,
} from './formErrors';

// ── The contract, mirrored (tests/lib/applicationForm.spec.ts) ──────────────────────────

/** Schema key → form control name: APPLICATION_FORM_FIELDS read backwards. */
export const APPLY_FIELD_OF_KEY = {
  name: 'name',
  email: 'email',
  phone: 'phone',
  city: 'city',
  role: 'role',
  experience: 'experience',
  workType: 'work_type',
  availability: 'availability',
  skills: 'skills',
  portfolio: 'portfolio',
  linkedin: 'linkedin',
  message: 'message',
  consentApplication: 'consent_application',
  consentFutureRoles: 'consent_future',
  policyVersion: 'policy_version',
  locale: 'locale',
} as const;

/** CV_MAX_BYTES. */
export const CV_LIMIT_BYTES = 10 * 1024 * 1024;
/** CV_KINDS' extensions (a .doc is refused — owner decision J2). */
export const CV_EXTENSIONS = ['pdf', 'docx'] as const;

/** The schema keys a 422 named → the controls to mark (unknown keys are dropped). */
export function applyFieldsFor(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  const out = new Set<string>();
  for (const key of keys) {
    if (typeof key === 'string' && Object.hasOwn(APPLY_FIELD_OF_KEY, key)) {
      out.add(APPLY_FIELD_OF_KEY[key as keyof typeof APPLY_FIELD_OF_KEY]);
    }
  }
  return [...out];
}

// ── Pure decisions (unit-tested) ─────────────────────────────────────────────────────────

export type CvProblem = 'tooLarge' | 'badType';

/**
 * Whether a chosen CV may be sent: a .pdf or .docx (by name — the server also checks the
 * bytes), not empty, at most the limit. Null for no file (the CV is optional) or a good one.
 */
export function cvProblem(
  file: { name: string; size: number } | null | undefined,
  limit: number = CV_LIMIT_BYTES,
): CvProblem | null {
  if (!file) return null;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  if (!ext || !(CV_EXTENSIONS as readonly string[]).includes(ext) || file.size === 0) {
    return 'badType';
  }
  return file.size > limit ? 'tooLarge' : null;
}

const NUMBERS = {
  en: new Intl.NumberFormat('en', { maximumFractionDigits: 1 }),
  ar: new Intl.NumberFormat('ar-SA-u-nu-arab', { maximumFractionDigits: 1 }),
};
const ONE_DECIMAL = {
  en: new Intl.NumberFormat('en', { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  ar: new Intl.NumberFormat('ar-SA-u-nu-arab', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }),
};

/** "240 KB" / "1.2 MB" (the mockup's rounding), in the page's digits ("١٫٢ ميجابايت"). */
export function fileSizeLabel(
  bytes: number,
  locale: 'en' | 'ar',
  units: { kb: string; mb: string },
): string {
  const MB = 1024 * 1024;
  if (bytes < MB)
    return `${NUMBERS[locale].format(Math.max(1, Math.round(bytes / 1024)))} ${units.kb}`;
  return `${ONE_DECIMAL[locale].format(bytes / MB)} ${units.mb}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface ApplyAnswer {
  status: FormOutcome;
  /** The controls to mark, for an `invalid` answer that named its fields. */
  fields: string[];
}

/**
 * The endpoint's answer → what the visitor is told. The JSON `status` is taken at its word;
 * without one (a body that is not the endpoint's — a proxy page, an empty 200) the HTTP code
 * decides, and a 2xx with no `status: "ok"` is an error: an application is reported as
 * received only when the endpoint said so, with a 2xx.
 */
export function applyOutcome(http: number, body: unknown): ApplyAnswer {
  const named = outcomeOf(isRecord(body) ? body['status'] : undefined);
  const byHttp = applyStatusFromHttp(http);
  const success = http >= 200 && http < 300;
  let status: FormOutcome;
  if (named === 'ok') status = success ? 'ok' : byHttp;
  else if (named) status = named;
  else status = success ? 'error' : byHttp;
  const fields = status === 'invalid' && isRecord(body) ? applyFieldsFor(body['fields']) : [];
  return { status, fields };
}

/** GET /api/apply/status's body → open (true / false), or null when it is not that answer. */
export function openFromStatusBody(body: unknown): boolean | null {
  return isRecord(body) && typeof body['open'] === 'boolean' ? body['open'] : null;
}

// ── DOM ──────────────────────────────────────────────────────────────────────────────────

async function applicationsOpen(url: string): Promise<boolean | null> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
    // The body is read even when it is not an answer (a 404 page, a proxy's error): an
    // unread body is a response Chromium never finishes — the page would never go idle.
    const body: unknown = await res.json().catch(() => null);
    return res.ok ? openFromStatusBody(body) : null;
  } catch {
    return null;
  }
}

function focusFirstInvalid(form: HTMLFormElement): void {
  form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
}

/**
 * Wires one application form. Every hook is in the server's markup: the messages are the
 * form's / the region's data attributes (the module carries no copy), and the closed notice
 * is the element `data-closed-target` names.
 */
export function mountApplicationForm(form: HTMLFormElement): void {
  const region = document.getElementById('apply-status');
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!region || !submit) return;

  const d = form.dataset;
  const locale = d['locale'] === 'ar' ? 'ar' : 'en';
  const messages: Record<FieldProblem, string> = {
    required: d['errRequired'] ?? '',
    email: d['errEmail'] ?? '',
    url: d['errUrl'] ?? '',
    tooLong: d['errTooLong'] ?? '',
    invalid: d['errInvalid'] ?? '',
  };
  const consent = form.querySelector<HTMLInputElement>('input[name="consent_application"]');
  const consentLabel = consent
    ? (form.querySelector(`label[for="${consent.id}"]`) ?? consent)
    : null;
  const markConsent = () => {
    if (!consent || !consentLabel) return;
    markFieldError(consent, d['errConsent'] ?? messages.invalid, consentLabel);
  };

  // ── Closed ──
  const lead = d['closedTarget'] ? document.getElementById(d['closedTarget']) : null;
  let closed = lead?.dataset['closed'] === 'true';
  const setClosed = (next: boolean) => {
    closed = next;
    if (lead) lead.dataset['closed'] = String(next);
    submit.disabled = next;
  };
  void applicationsOpen(d['statusUrl'] ?? '/api/apply/status').then((open) => {
    if (open !== null) setClosed(!open);
  });

  // ── The CV dropzone ──
  const cv = form.querySelector<HTMLInputElement>('input[type="file"][name="cv"]');
  const drop = cv?.closest<HTMLElement>('[data-cv-drop]') ?? null;
  const nameEl = drop?.querySelector<HTMLElement>('[data-cv-name]') ?? null;
  const sizeEl = drop?.querySelector<HTMLElement>('[data-cv-size]') ?? null;
  const hintId = drop?.querySelector<HTMLElement>('[data-cv-hint]')?.id ?? '';
  const badId = drop?.querySelector<HTMLElement>('[data-cv-bad]')?.id ?? '';
  const units = { kb: drop?.dataset['kb'] ?? 'KB', mb: drop?.dataset['mb'] ?? 'MB' };

  /** Shows the chosen file's state (`refused`: the server would not take it). */
  const renderCv = (refused = false): CvProblem | null => {
    if (!cv || !drop) return null;
    const file = cv.files?.[0] ?? null;
    const problem = refused && file ? 'badType' : cvProblem(file);
    const state = !file ? 'empty' : problem ? 'bad' : 'ok';
    drop.dataset['state'] = state;
    if (nameEl) nameEl.textContent = file?.name ?? '';
    if (sizeEl)
      sizeEl.textContent = file && !problem ? fileSizeLabel(file.size, locale, units) : '';
    // The description is the line the zone shows: the rules, the size, or what is wrong.
    const described = state === 'bad' ? badId : state === 'ok' ? (sizeEl?.id ?? '') : hintId;
    if (described) cv.setAttribute('aria-describedby', described);
    if (problem) cv.setAttribute('aria-invalid', 'true');
    else cv.removeAttribute('aria-invalid');
    return problem;
  };

  clearErrorsOnInput(form);
  // After clearErrorsOnInput's own listener (registered first, so it runs first): a new
  // file clears the old error, then this re-judges the new one.
  form.addEventListener('change', (e) => {
    if (e.target === cv) renderCv();
  });

  if (cv && drop) {
    const over = (on: boolean) => drop.classList.toggle('is-over', on);
    for (const type of ['dragenter', 'dragover'] as const) {
      drop.addEventListener(type, (e) => {
        e.preventDefault();
        over(true);
      });
    }
    drop.addEventListener('dragleave', (e) => {
      if (!(e.relatedTarget instanceof Node && drop.contains(e.relatedTarget))) over(false);
    });
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      over(false);
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      // One file only (the input takes one); the same change path as the picker.
      const one = new DataTransfer();
      one.items.add(file);
      cv.files = one.files;
      cv.dispatchEvent(new Event('change', { bubbles: true }));
    });
    drop.querySelector<HTMLButtonElement>('[data-cv-remove]')?.addEventListener('click', () => {
      cv.value = '';
      cv.dispatchEvent(new Event('change', { bubbles: true }));
      // The button hides with the file; keep keyboard focus in the dropzone.
      cv.focus();
    });
    renderCv();
  }

  // ── Submit ──
  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || closed) return;

    const problems = checkForm(form);
    showFieldErrors(form, problems, messages, { focus: false });
    const cvBad = renderCv();
    if (consent) clearFieldError(consent);
    const noConsent = consent !== null && !consent.checked;
    if (noConsent) markConsent();
    if (problems.size > 0 || cvBad || noConsent) {
      showStatus(form, region, 'invalid');
      focusFirstInvalid(form);
      return;
    }

    const body = new FormData(form);
    if (!cv?.files?.length) body.delete('cv');
    busy = true;
    showStatus(form, region, 'sending');
    try {
      const res = await fetch(form.getAttribute('action') ?? '/api/apply', {
        method: 'POST',
        headers: { accept: 'application/json' },
        body,
      });
      const json: unknown = await res.json().catch(() => null);
      const { status, fields } = applyOutcome(res.status, json);
      if (status === 'invalid' && fields.length > 0) {
        const named = new Map(fields.map((f) => [f, 'invalid' as const]));
        showFieldErrors(form, named, messages, { focus: false });
        renderCv();
        if (consent && named.has(consent.name)) markConsent();
      }
      if (status === 'too_large' || status === 'bad_type') renderCv(true);
      if (status === 'closed') setClosed(true);
      if (status === 'ok') {
        form.reset();
        renderCv();
      }
      showStatus(form, region, status);
      if (status === 'invalid' || status === 'too_large' || status === 'bad_type') {
        focusFirstInvalid(form);
      }
    } catch {
      showStatus(form, region, 'error');
    } finally {
      busy = false;
    }
  });
}
