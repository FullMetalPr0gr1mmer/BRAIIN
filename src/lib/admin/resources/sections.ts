import { SectionUpdateSchema, SectionWriteSchema } from '@schemas/admin';
import { sectionContentIssues, type SectionType } from '@schemas/sections';
import { MEDIA_BLOCKS_FULL, MEDIA_BLOCKS_PER_PAGE, MEDIA_BLOCK_TYPES } from '@schemas/sectionTypes';
import {
  CUSTOM_PAGE_TYPE_REFUSED,
  isCustomPageSectionType,
  isCustomPageSlug,
} from '@schemas/customPages';
import {
  ANCHOR_CODE_OWNED,
  ANCHOR_DISCIPLINE,
  ANCHOR_TAKEN,
  appearanceProblem,
  takesAnchor,
} from '@schemas/sectionAppearance';
import { isSampleRating } from '@/lib/sections/samples';
import { liveDb, type DbListQuery } from '@/lib/release/overlayDb';
import { ValidationError } from '../errors';
import type { ResourceConfig } from '../resource';
import { fieldsOf, pick, type Input } from './shared';

// Page sections: content typed per section type (packages/schemas/sections.ts).

// `style` is deliberately absent: it is no longer writable (see SectionWriteSchema).
const SECTION_KEYS = {
  pageId: 'page_id',
  type: 'type',
  content: 'content',
  visible: 'visible',
  sortOrder: 'sort_order',
  isPlaceholder: 'is_placeholder',
  // Admin v2 E1 (0115): the section's name in the page editor's sections column. Written only
  // when a payload carries it (the Rename dialog); the legacy section form never sends it.
  label: 'label',
  // Admin v2 E9 (0127): the section's appearance and anchor (packages/schemas/sectionAppearance.ts).
  // Written only when a payload carries them (the page editor's Appearance card).
  background: 'background',
  spacing: 'spacing',
  reveal: 'reveal',
  anchor: 'anchor',
};

/** The variant a section's content holds (the Numbers band names its own anchor). */
const variantOfContent = (content: unknown): unknown =>
  content && typeof content === 'object'
    ? (content as Record<string, unknown>)['variant']
    : undefined;

const MEDIA_TYPES: readonly unknown[] = MEDIA_BLOCK_TYPES;

/**
 * The read of a section's page for the custom page rule below (Admin v2 E11). One shape, so a
 * publish answers it from its batched read of the release's links (src/lib/release/validate.ts
 * primeLinks) and the rule costs a release no request of its own.
 */
export function sectionPageQuery(pageId: string): DbListQuery {
  return { columns: 'id,slug', eq: { id: pageId }, limit: 1 };
}

export const sectionResource: ResourceConfig = {
  table: 'page_sections',
  // A visible section on a published page is live copy, so turning `visible` on is gated
  // as a publish (content.publish). Every role that may edit sections holds it today; the
  // flag keeps the two capabilities from drifting apart unnoticed.
  publishFlag: 'visible',
  entity: 'page_section',
  writeCap: 'pages.write',
  listColumns: 'id,page_id,type,label,anchor,visible,sort_order,is_placeholder,version,updated_at',
  columns:
    'id,page_id,type,label,content,visible,sort_order,is_placeholder,background,spacing,reveal,' +
    'anchor,version,created_at,updated_at',
  orderBy: { column: 'sort_order', ascending: true },
  filterableColumns: ['page_id'],
  createSchema: SectionWriteSchema,
  updateSchema: SectionUpdateSchema,
  toRow: (input) => pick(input as Input, SECTION_KEYS),
  fields: fieldsOf(SECTION_KEYS),
  // Admin v2 E9: the database's own refusals (0127), on the field that caused them. The Worker's
  // rules below say the same first; these catch a write that reached the CHECKs another way.
  constraintFields: {
    page_sections_background_bucket: {
      field: 'background',
      message: 'This kind of section keeps its own background: its colours are part of its design.',
    },
    page_sections_spacing_bucket: {
      field: 'spacing',
      message: 'This kind of section keeps its own spacing: it is part of its layout.',
    },
    page_sections_reveal_bucket: {
      field: 'reveal',
      message: 'This kind of section opens a page, so it always shows at once: it takes no reveal.',
    },
    page_sections_anchor_shape: {
      field: 'anchor',
      message:
        'Use lower-case letters and numbers, with single hyphens between words, at most 40, and not a name the site uses itself.',
    },
    page_sections_anchor_unique: { field: 'anchor', message: ANCHOR_TAKEN },
  },
  // The schema validates content only when a payload carries BOTH type and content. A
  // PATCH of content alone (or of type alone) is checked here, against the type the row
  // will have — otherwise it saves "fine" and the loader silently drops it.
  assertWritable: async (merged, { changed, auth, sb, db, before }) => {
    if ('type' in changed || 'content' in changed) {
      const [issue] = sectionContentIssues(merged['type'] as SectionType, merged['content'] ?? {});
      if (issue) {
        const where = issue.path.slice(1).join('.');
        throw new ValidationError(where ? `${where}: ${issue.message}` : issue.message, 'content');
      }
    }
    // The sample-rating guard (Round 3). The proof band's "4.9 / 5" lives INSIDE the
    // section's content, where the row-level placeholder rule (refusePlaceholder, the
    // 0025 trigger) cannot see it: unticking "Placeholder" with the sample still stored
    // would publish a rating no review data backs, unflagged. Judged on the merged row,
    // so untick + a real rating in the same save passes, and a reorder never trips it.
    if (
      ('is_placeholder' in changed || 'content' in changed) &&
      merged['is_placeholder'] !== true &&
      merged['type'] === 'statistics' &&
      isSampleRating((merged['content'] as Record<string, unknown> | null)?.['rating'])
    ) {
      throw new ValidationError(
        'the rating line still shows the design sample (4.9 / 5 under its sample label) — give it a real, sourced rating (a real label under the same number passes) or remove it before unticking “Placeholder”',
        'is_placeholder' in changed ? 'isPlaceholder' : 'content',
      );
    }
    // The media block cap (Admin v2 E10 review): a Gallery or a Video joining a page (created,
    // moved, or turned into one) finds at most MEDIA_BLOCKS_PER_PAGE - 1 others there, hidden
    // ones included. Counted through the overlay-aware database when given (a staged save sees
    // the pending sections of the tenant, a publish the ones its release leaves), the row
    // itself left out by id. One indexed read, and only for a row that BECOMES a media block
    // on this page (E10 code review, CR4): the editor's form sends `type` with every save, so
    // a row that already was one there (`before`) is not counted again, and an edit of a block
    // on a page already over the cap (rows written around the API, or two saves racing) still
    // saves. The race itself stays open: the count and the insert are two statements.
    if (
      ('type' in changed || 'page_id' in changed) &&
      MEDIA_TYPES.includes(merged['type']) &&
      typeof merged['page_id'] === 'string' &&
      !(before && MEDIA_TYPES.includes(before['type']) && before['page_id'] === merged['page_id'])
    ) {
      const rows = await (db ?? liveDb(sb, auth)).list('page_sections', {
        columns: 'id,type',
        eq: { page_id: merged['page_id'] },
        in: { type: [...MEDIA_BLOCK_TYPES] },
        limit: MEDIA_BLOCKS_PER_PAGE + 1,
      });
      const others = rows.filter((row) => row['id'] !== merged['id']).length;
      if (others >= MEDIA_BLOCKS_PER_PAGE) throw new ValidationError(MEDIA_BLOCKS_FULL, 'type');
    }
    // A custom page's set (Admin v2 E11): a section joining a custom page (created there, moved
    // there, or turned into another type) must be one a custom page holds. The page's slug is
    // read through the same overlay-aware database (a pending page's own, with releases on),
    // and only for a type outside the set that BECOMES this page's: every type in the set is
    // allowed everywhere, and an edit that keeps a row's type and page (the form sends `type`
    // with every save) reads nothing. The page never renders a type outside the set either
    // (src/lib/sections/customPage.ts), so a row written around the API shows nothing.
    if (
      ('type' in changed || 'page_id' in changed) &&
      !isCustomPageSectionType(merged['type']) &&
      typeof merged['page_id'] === 'string' &&
      !(before && before['type'] === merged['type'] && before['page_id'] === merged['page_id'])
    ) {
      const page = await (db ?? liveDb(sb, auth)).first(
        'pages',
        sectionPageQuery(merged['page_id']),
      );
      const slug = typeof page?.['slug'] === 'string' ? page['slug'].toLowerCase() : null;
      if (slug !== null && isCustomPageSlug(slug)) {
        throw new ValidationError(CUSTOM_PAGE_TYPE_REFUSED, 'type');
      }
    }
    // Section appearance (Admin v2 E9): a background, spacing or reveal only on the kinds that
    // take it, judged on the merged row, so a type change that leaves a choice its new kind
    // does not take is refused too (the E9 migration's CHECKs hold the same; this says it on the
    // field first). No read.
    if (['type', 'background', 'spacing', 'reveal'].some((key) => key in changed)) {
      const problem = appearanceProblem(String(merged['type']), {
        background: merged['background'],
        spacing: merged['spacing'],
        reveal: merged['reveal'],
      });
      if (problem) throw new ValidationError(problem.message, problem.field);
    }
    // The anchor (Admin v2 E9): never on a section whose component names its own (the editor
    // shows that one), judged on every save that could make it one (the form sends `type` and
    // `content` with every save; no read). Unique on its page and never a discipline's slug (the
    // Services explorer's panels are ids named by them): read only when the anchor or its page
    // MOVES (a save that restates them reads nothing), through the overlay-aware database, so a
    // staged save sees the pending anchors of the tenant and a publish the ones its release
    // leaves; the two reads go together (listMany), only for a save that moves the anchor.
    // The database's deferred UNIQUE (tenant, page, anchor) is the second net; a discipline
    // renamed later onto an anchor is dropped at render (src/lib/sections/appearance.ts),
    // never a duplicate id.
    const anchor = merged['anchor'];
    if (
      typeof anchor === 'string' &&
      ['anchor', 'type', 'content', 'page_id'].some((key) => key in changed)
    ) {
      if (!takesAnchor(String(merged['type']), variantOfContent(merged['content']))) {
        throw new ValidationError(ANCHOR_CODE_OWNED, 'anchor');
      }
      const moved =
        !before || before['anchor'] !== anchor || before['page_id'] !== merged['page_id'];
      if (moved && typeof merged['page_id'] === 'string') {
        const [sections = [], disciplines = []] = await (db ?? liveDb(sb, auth)).listMany([
          {
            table: 'page_sections',
            query: { columns: 'id', eq: { page_id: merged['page_id'], anchor }, limit: 2 },
          },
          { table: 'disciplines', query: { columns: 'id', eq: { slug: anchor }, limit: 1 } },
        ]);
        if (sections.some((row) => row['id'] !== merged['id'])) {
          throw new ValidationError(ANCHOR_TAKEN, 'anchor');
        }
        if (disciplines.length > 0) throw new ValidationError(ANCHOR_DISCIPLINE, 'anchor');
      }
    }
  },
};
