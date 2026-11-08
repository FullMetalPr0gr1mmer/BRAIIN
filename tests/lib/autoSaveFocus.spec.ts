import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { entitySaveReducer, initialSaveState } from '@/lib/admin/entitySave';
import type { FieldDef } from '@/lib/admin/uiSchema';

// Admin v2 R14f: a refused AUTOMATIC save shows its errors without moving focus.
//
// In release mode an editor saves by itself when focus leaves a field it changed (P-5). The
// rehearsal's section-blocks spec emptied a Text block's Arabic body, moved to another field
// (the blur saved, and the server refused the empty body), then pressed "Next gap": focus went
// to the Arabic body, and the error summary, appearing a moment later for the refused automatic
// save, took it away (ErrorSummary focuses itself when a new set of errors appears). A focus
// move nobody asked for (WCAG 3.2.2). The summary now takes focus only after the person's own
// Save was refused; after an automatic one it shows, and focus stays where the person put it.
//
// No DOM here: the reducer says which kind of save was refused, and the form reads it.

const FIELDS: readonly FieldDef[] = [{ name: 'title', label: 'Title', kind: 'text' }];
const ERRORS = {
  byId: { title: 'Required' },
  summary: [{ id: 'f-title', message: 'Title: Required' }],
};

function refused(auto: boolean | undefined) {
  const ready = entitySaveReducer(initialSaveState(FIELDS, false), {
    type: 'loaded',
    row: { title: 'x', version: 1 },
    fields: FIELDS,
    versionFallback: 0,
  });
  const saving = entitySaveReducer(ready, { type: 'save-start' });
  return entitySaveReducer(saving, {
    type: 'save-failed',
    message: null,
    errors: ERRORS,
    ...(auto === undefined ? {} : { auto }),
  });
}

describe('which refused save the form is showing (R14f)', () => {
  it('an automatic save refused: the state says so', () => {
    expect(refused(true).autoBlocked).toBe(true);
  });

  it("the person's own Save refused (and a refusal that names no kind): not automatic", () => {
    expect(refused(false).autoBlocked).toBe(false);
    expect(refused(undefined).autoBlocked).toBe(false);
  });

  it('the hook hands it to the form, and the form keeps focus put after an automatic refusal', () => {
    const hook = readFileSync('src/lib/admin/useEntitySave.ts', 'utf8');
    expect(hook).toContain('refusedAuto: state.autoBlocked,');
    const form = readFileSync('src/components/admin/fields/EditorForm.tsx', 'utf8');
    expect(form).toMatch(
      /<ErrorSummary errors=\{errors\.summary\} focus=\{save\.refusedAuto !== true\} \/>/,
    );
    // The summary still focuses itself by default (every other form's refusal is the person's).
    const summary = readFileSync('src/components/admin/kit/ErrorSummary.tsx', 'utf8');
    expect(summary).toMatch(/focus = true/);
    expect(summary).toMatch(/if \(focus && signature\) box\.current\?\.focus\(\);/);
  });
});
