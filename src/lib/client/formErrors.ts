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
//
// The decisions are pure functions (checkField, statusFromHttp) so they are unit-tested;
// the DOM half is exercised by the page e2e suites.

export type FormStatus = 'sending' | 'ok' | 'invalid' | 'rate_limited' | 'unavailable' | 'error';
export type FieldProblem = 'required' | 'email' | 'tooLong' | 'invalid';

/** The HTTP answer → what the visitor is told. */
export function statusFromHttp(status: number): Exclude<FormStatus, 'sending'> {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 400 || status === 422) return 'invalid';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'unavailable';
  return 'error';
}

export interface FieldRule {
  required?: boolean;
  email?: boolean;
  maxLength?: number;
}

// Deliberately loose (the server's z.string().email() is the gate): one @, a dot in the
// domain, no spaces — the design's own check.
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** One control's value against its rule; null when it passes. */
export function checkField(value: string, rule: FieldRule): FieldProblem | null {
  const v = value.trim();
  if (v === '') return rule.required ? 'required' : null;
  if (rule.email && !EMAIL.test(v)) return 'email';
  // Code points, as the server's .max() counts UTF-16 units — a code-point count is never
  // larger, so the client can never block what the server would accept.
  if (rule.maxLength !== undefined && [...value].length > rule.maxLength) return 'tooLong';
  return null;
}

// ── DOM ─────────────────────────────────────────────────────────────────────────

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

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

/** The rule a control's own attributes declare (required, type=email, maxlength). */
export function ruleOf(control: Control): FieldRule {
  const max = control instanceof HTMLSelectElement ? -1 : control.maxLength;
  return {
    required: control.required,
    email: control instanceof HTMLInputElement && control.type === 'email',
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
 * Marks the failing controls (and clears the rest), each with its message; focuses the
 * first. `messages` carries the localized copy for each problem.
 */
export function showFieldErrors(
  form: HTMLFormElement,
  problems: Map<string, FieldProblem>,
  messages: Record<FieldProblem, string>,
): void {
  let first: Control | null = null;
  for (const c of controls(form)) {
    clearFieldError(c);
    const problem = problems.get(c.name);
    if (!problem) continue;
    const id = errorIdFor(c);
    const note = document.createElement('p');
    note.className = 'field-error';
    note.id = id;
    note.textContent = messages[problem];
    c.insertAdjacentElement('afterend', note);
    c.setAttribute('aria-invalid', 'true');
    const described = c.getAttribute('aria-describedby');
    c.setAttribute('aria-describedby', described ? `${described} ${id}` : id);
    c.closest('.field')?.classList.add('is-invalid');
    first ??= c;
  }
  first?.focus();
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
  const key = status === 'rate_limited' ? 'rateLimited' : status;
  region.hidden = false;
  region.textContent = region.dataset[key] ?? region.dataset['error'] ?? '';
  region.classList.toggle('is-ok', status === 'ok');
  region.classList.toggle('is-error', status !== 'ok' && status !== 'sending');
  form.classList.toggle('is-sent', status === 'ok');
  form.setAttribute('aria-busy', status === 'sending' ? 'true' : 'false');
  if (status === 'ok') region.focus();
}
