import { describe, it, expect } from 'vitest';
import {
  SECTION_TYPES,
  SECTION_CONTENT_SCHEMAS,
  sectionContentIssues,
  type SectionType,
} from '@schemas/sections';
import { RENDERED_SECTION_TYPES } from '@/lib/sections/registry';
import {
  DEFAULT_ABOUT_SECTIONS,
  DEFAULT_CATALOG_SECTIONS,
  DEFAULT_CONTACT_SECTIONS,
  DEFAULT_HOME_SECTIONS,
  DEFAULT_WORK_SECTIONS,
} from '@/lib/sections/types';
import { loadBlocks } from '../../scripts/gen-seeds.mjs';

// The section contract has four places that must agree:
//   packages/schemas SECTION_TYPES   what the CMS accepts on write
//   registry RENDERED_SECTION_TYPES  what SectionRenderer renders (astro check holds the
//                                    .astro map to THIS list)
//   the DEFAULT_* compositions       what a page renders before it is authored
//   seeded page_sections             what dev/CI/staging render
// A type in the first but not the second is a section an editor saves and a visitor never
// sees; a default or seed naming an unknown type silently drops a band from a page.

const sorted = (xs: readonly string[]) => [...xs].sort();

describe('section type contract', () => {
  it('the CMS accepts exactly the types the renderer renders', () => {
    expect(sorted(RENDERED_SECTION_TYPES)).toEqual(sorted(SECTION_TYPES));
  });

  it('every content schema belongs to a known type', () => {
    for (const type of Object.keys(SECTION_CONTENT_SCHEMAS)) {
      expect(SECTION_TYPES as readonly string[]).toContain(type);
    }
  });

  it('every built-in default composition uses known types', () => {
    for (const s of [
      ...DEFAULT_HOME_SECTIONS,
      ...DEFAULT_ABOUT_SECTIONS,
      ...DEFAULT_CONTACT_SECTIONS,
      ...DEFAULT_WORK_SECTIONS,
      ...DEFAULT_CATALOG_SECTIONS,
    ]) {
      expect(SECTION_TYPES as readonly string[], `default uses '${s.type}'`).toContain(s.type);
    }
  });

  it('every seeded page_section uses a known type', () => {
    const seeded = (loadBlocks() as unknown as { table: string; rows: { type?: string }[] }[])
      .filter((b) => b.table === 'page_sections')
      .flatMap((b) => b.rows.map((r) => r.type));
    for (const type of seeded) expect(SECTION_TYPES as readonly string[]).toContain(type);
  });

  it('every seeded page_section content is valid for its type (else it renders the defaults)', () => {
    // The public loader silently falls back to built-in copy on invalid content, so a seed
    // typo would never show as an error — only as the wrong page.
    const seeded = (
      loadBlocks() as unknown as { table: string; rows: { type?: string; content?: unknown }[] }[]
    )
      .filter((b) => b.table === 'page_sections')
      .flatMap((b) => b.rows);
    for (const row of seeded) {
      const issues = sectionContentIssues(row.type as SectionType, row.content ?? {});
      expect(issues, `${row.type}: ${JSON.stringify(issues)}`).toEqual([]);
    }
  });
});
