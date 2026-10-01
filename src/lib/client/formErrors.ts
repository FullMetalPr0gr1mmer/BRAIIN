// Real submission status and per-field errors for the public forms (UI v2 PR7: the home
// contact form; PR9's full contact form and the Join form reuse it).
//
// The design marked a bad field with a red border and nothing else. That fails WCAG 3.3.1
// (no text says what is wrong) and 1.4.1 (colour is the only cue), and the design's form
// also showed "sent" whatever the server said. Here:
//   • each invalid control gets aria-invalid, a visible .field-error message and
//     aria-describedby pointing at it; focus moves to the first one;
//   • the client checks mirror the Zod bounds the server applies (required, email shape,
//     maxlength), so a visitor is told before a round trip — the server stays the gate;
//   • the status region reports what actually happened, from the HTTP status: sent,
//     invalid (with the fields the server named), rate-limited, unavailable, or an error.
//     The Join application adds its endpoint's three (the file was too large or not a PDF
//     or .docx, applications are closed) — the set is APPLY_STATUSES exactly
//     (packages/schemas/application.ts; tests/lib/applicationForm.spec.ts holds the two
//     equal — this module stays zod-free, it ships to the browser).
//
// The decisions are pure functions (checkField, statusFromHttp, applyStatusFromHttp) so
// they are unit-tested; the DOM half is exercised by the page e2e suites.

export type FormStatus =
  | 'sending'
  | 'ok'
  | 'invalid'
  | 'rate_limited'
  | 'unavailable'
  | 'error'
  // The application endpoint's own (/api/apply — Join)
  | 'too_large'
  | 'bad_type'
  | 'closed';
export type FieldProblem = 'required' | 'email' | 'url' | 'tooLong' | 'invalid';

/** Every outcome a submission can end in (all but the transient `sending`). */
export type FormOutcome = Exclude<FormStatus, 'sending'>;
export const FORM_OUTCOMES = [
  'ok',
  'invalid',
  'too_large',
  'bad_type',
  'rate_limited',
  'unavailable',
  'closed',
  'error',
] as const satisfies readonly FormOutcome[];

/** The HTTP answer → what the visitor is told. */
export function statusFromHttp(status: number): Exclude<FormStatus, 'sending'> {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 400 || status === 422) return 'invalid';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'unavailable';
  return 'error';
}

/**
 * The application endpoint's HTTP answer → its outcome (APPLY_HTTP_STATUS read backwards:
 * 409 closed, 413 too large, 415 not a PDF or .docx). For an answer whose JSON body could
 * not be read; a body that names its `status` is taken at its word (outcomeOf).
 */
export function applyStatusFromHttp(status: number): FormOutcome {
  if (status === 409) return 'closed';
  if (status === 413) return 'too_large';
  if (status === 415) return 'bad_type';
  return statusFromHttp(status);
}

/** A JSON answer's `status`, when it is an outcome this module has copy for; else null. */
export function outcomeOf(value: unknown): FormOutcome | null {
  return typeof value === 'string' && (FORM_OUTCOMES as readonly string[]).includes(value)
    ? (value as FormOutcome)
    : null;
}

export interface FieldRule {
  required?: boolean;
  email?: boolean;
  /** An absolute https:// link (the application's portfolio and LinkedIn — https only). */
  url?: boolean;
  maxLength?: number;
}

// Deliberately loose (the server's z.string().email() is the gate): one @, a dot in the
// domain, no spaces — the design's own check.
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * The server's link rule (z.string().url() plus "https only"): whatever `new URL` parses,
 * with the https scheme. As loose as the server and no looser — the client must never
 * refuse a link the server would take (`https://localhost` included).
 */
function isHttpsUrl(v: string): boolean {
  try {
    const url = new URL(v);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}

/** One control's value against its rule; null when it passes. */
export function checkField(value: string, rule: FieldRule): FieldProblem | null {
  const v = value.trim();
  if (v === '') return rule.required ? 'required' : null;
  if (rule.email && !EMAIL.test(v)) return 'email';
  if (rule.url && !isHttpsUrl(v)) return 'url';
  // Code points, as the server's .max() counts UTF-16 units — a code-point count is never
  // larger, so the client can never block what the server would accept.
  if (rule.maxLength !== undefined && [...value].length > rule.maxLength) return 'tooLong';
  return null;
}

// ── DOM ─────────────────────────────────────────────────────────────────────────

export type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type Control = FormControl;

// `unknown`, not Element: HTMLSelectElement's remove(index) overload makes it not assignable
// to Element, so a predicate over Element cannot narrow to it.
const isControl = (el: unknown): el is Control =>
  el instanceof HTMLInputElement ||
  el instanceof HTMLSelectElement ||
  el instanceof HTMLTextAreaElement;

function controls(form: HTMLFormElement): Control[] {
  const out: Control[] = [];
  for (const el of form.elements) {
    if (isControl(el) && el.name !== '' && el.type !== 'checkbox' && el.type !== 'hidden') {
      out.push(el);
    }
  }
  return out;
}

/** The rule a control's own attributes declare (required, type=email|url, maxlength). */
export function ruleOf(control: Control): FieldRule {
  const max = control instanceof HTMLSelectElement ? -1 : control.maxLength;
  return {
    required: control.required,
    email: control instanceof HTMLInputElement && control.type === 'email',
    url: control instanceof HTMLInputElement && control.type === 'url',
    ...(max > 0 ? { maxLength: max } : {}),
  };
}

/** Every failing control in DOM order, by name. The honeypot is never checked. */
export function checkForm(form: HTMLFormElement): Map<string, FieldProblem> {
  const out = new Map<string, FieldProblem>();
  for (const c of controls(form)) {
    if (c.name === 'hp') continue;
    const problem = checkField(c.value, ruleOf(c));
    if (problem) out.set(c.name, problem);
  }
  return out;
}

function errorIdFor(control: Control): string {
  return `${control.id || control.name}-error`;
}

/** Removes one control's error state (and only the describedby token it added). */
export function clearFieldError(control: Control): void {
  const id = errorIdFor(control);
  control.removeAttribute('aria-invalid');
  const tokens = (control.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter((t) => t && t !== id);
  if (tokens.length) control.setAttribute('aria-describedby', tokens.join(' '));
  else control.removeAttribute('aria-describedby');
  control.closest('.field')?.classList.remove('is-invalid');
  document.getElementById(id)?.remove();
}

/**
 * Marks ONE control invalid with its message: aria-invalid, a .field-error note (after the
 * control, or after `after` — a checkbox's note goes after its label) and aria-describedby
 * pointing at it. Any earlier error on the control is cleared first.
 */
export function markFieldError(
  control: Control,
  message: string,
  after?: Pick<Element, 'insertAdjacentElement'>,
): void {
  clearFieldError(control);
  const id = errorIdFor(control);
  const note = document.createElement('p');
  note.className = 'field-error';
  note.id = id;
  note.textContent = message;
  (after ?? control).insertAdjacentElement('afterend', note);
  control.setAttribute('aria-invalid', 'true');
  const described = control.getAttribute('aria-describedby');
  control.setAttribute('aria-describedby', described ? `${described} ${id}` : id);
  control.closest('.field')?.classList.add('is-invalid');
}

/**
 * Marks the failing controls (and clears the rest), each with its message; focuses the
 * first unless `focus: false` (a form that marks more controls itself and then focuses the
 * first of them all). `messages` carries the localized copy for each problem.
 */
export function showFieldErrors<P extends string = FieldProblem>(
  form: HTMLFormElement,
  problems: ReadonlyMap<string, P>,
  messages: Readonly<Record<P, string>>,
  options: { focus?: boolean } = {},
): void {
  let first: Control | null = null;
  for (const c of controls(form)) {
    clearFieldError(c);
    const problem = problems.get(c.name);
    if (!problem) continue;
    markFieldError(c, messages[problem]);
    first ??= c;
  }
  if (options.focus !== false) first?.focus();
}

/** Typing into (or changing) a marked control clears its error. */
export function clearErrorsOnInput(form: HTMLFormElement): void {
  const clear = (e: Event) => {
    const target = e.target;
    if (isControl(target) && target.getAttribute('aria-invalid') === 'true') {
      clearFieldError(target);
    }
  };
  form.addEventListener('input', clear);
  form.addEventListener('change', clear);
}

/**
 * Writes a status into the live region, from its data-<status> copy. `ok` also marks the
 * form sent (the fields give way to the confirmation) and moves focus to it, so a
 * keyboard or screen-reader user is not left on a control that just disappeared.
 */
export function showStatus(form: HTMLFormElement, region: HTMLElement, status: FormStatus): void {
  // data-<status> in kebab case: `rate_limited` reads data-rate-limited (dataset.rateLimited)
  const key = status.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  region.hidden = false;
  region.textContent = region.dataset[key] ?? region.dataset['error'] ?? '';
  region.classList.toggle('is-ok', status === 'ok');
  region.classList.toggle('is-error', status !== 'ok' && status !== 'sending');
  form.classList.toggle('is-sent', status === 'ok');
  form.setAttribute('aria-busy', status === 'sending' ? 'true' : 'false');
  if (status === 'ok') region.focus();
}
