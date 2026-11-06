import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * The shared confirm dialog (src/lib/admin/confirm.ts) is named by its question (Admin v2 Z1).
 * A dialog must have an accessible name (WCAG 4.1.2); axe's rule for it (aria-dialog-name) is a
 * best-practice rule, outside the WCAG tags every admin axe run uses, so the nameless confirm
 * passed every check until the dialog matrix asked each open dialog for its name
 * (tests/admin/dialogs.e2e.ts). Vitest runs in node: a minimal document stands in for the DOM.
 */

interface FakeElement {
  tag: string;
  id: string;
  className: string;
  textContent: string;
  value: string;
  method: string;
  returnValue: string;
  dataset: Record<string, string>;
  attributes: Map<string, string>;
  children: FakeElement[];
  listeners: Map<string, () => void>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeElement): FakeElement;
  addEventListener(type: string, fn: () => void): void;
  showModal(): void;
}

function fakeElement(tag: string): FakeElement {
  const el: FakeElement = {
    tag,
    id: '',
    className: '',
    textContent: '',
    value: '',
    method: '',
    returnValue: '',
    dataset: {},
    attributes: new Map(),
    children: [],
    listeners: new Map(),
    setAttribute(name, value) {
      el.attributes.set(name, value);
    },
    getAttribute(name) {
      return el.attributes.get(name) ?? null;
    },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    addEventListener(type, fn) {
      el.listeners.set(type, fn);
    },
    showModal() {},
  };
  return el;
}

function install() {
  const body = fakeElement('body');
  const made: FakeElement[] = [];
  vi.stubGlobal('document', {
    body,
    createElement(tag: string) {
      const el = fakeElement(tag);
      made.push(el);
      return el;
    },
  });
  return { body, made };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('confirmDialog', () => {
  it('names the dialog by its message (aria-labelledby the question)', async () => {
    const { body } = install();
    const { confirmDialog, CONFIRM_MESSAGE_ID } = await import('@/lib/admin/confirm');
    void confirmDialog({ message: 'Delete the sample?', confirmLabel: 'Delete' });

    const dialog = body.children.find((el) => el.tag === 'dialog');
    expect(dialog, 'the confirm is appended to the body').toBeDefined();
    const labelledBy = dialog!.getAttribute('aria-labelledby');
    expect(labelledBy).toBe(CONFIRM_MESSAGE_ID);
    const message = dialog!.children.find((el) => el.id === labelledBy);
    expect(message?.tag).toBe('p');
    expect(message?.textContent).toBe('Delete the sample?');
  });

  it('keeps one dialog, renamed by each new question', async () => {
    const { made } = install();
    const { confirmDialog, CONFIRM_MESSAGE_ID } = await import('@/lib/admin/confirm');
    void confirmDialog({ message: 'First?' });
    void confirmDialog({ message: 'Second?' });
    expect(made.filter((el) => el.tag === 'dialog')).toHaveLength(1);
    expect(made.find((el) => el.id === CONFIRM_MESSAGE_ID)?.textContent).toBe('Second?');
  });
});
