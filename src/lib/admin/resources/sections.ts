import { SectionUpdateSchema, SectionWriteSchema } from '@schemas/admin';
import { sectionContentIssues, type SectionType } from '@schemas/sections';
import {
  MEDIA_BLOCKS_FULL,
  MEDIA_BLOCKS_PER_PAGE,
  MEDIA_BLOCK_TYPES,
} from '@schemas/sectionTypes';
import { isSampleRating } from '@/lib/sections/samples';
import { liveDb } from '@/lib/release/overlayDb';
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
};

const MEDIA_TYPES: readonly unknown[] = MEDIA_BLOCK_TYPES;

export const sectionResource: ResourceConfig = {
  table: 'page_sections',
  // A visible section on a published page is live copy, so turning `visible` on is gated
  // as a publish (content.publish). Every role that may edit sections holds it today; the
  // flag keeps the two capabilities from drifting apart unnoticed.
  publishFlag: 'visible',
  entity: 'page_section',
  writeCap: 'pages.write',
  listColumns: 'id,page_id,type,label,visible,sort_order,is_placeholder,version,updated_at',
  columns:
    'id,page_id,type,label,content,visible,sort_order,is_placeholder,version,created_at,updated_at',
  orderBy: { column: 'sort_order', ascending: true },
  filterableColumns: ['page_id'],
  createSchema: SectionWriteSchema,
  updateSchema: SectionUpdateSchema,
  toRow: (input) => pick(input as Input, SECTION_KEYS),
  fields: fieldsOf(SECTION_KEYS),
  // The schema validates content only when a payload carries BOTH type and content. A
  // PATCH of content alone (or of type alone) is checked here, against the type the row
  // will have — otherwise it saves "fine" and the loader silently drops it.
  assertWritable: async (merged, { changed, auth, sb, db }) => {
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
    // itself left out by id. One indexed read, and only for a media block.
    if (
      ('type' in changed || 'page_id' in changed) &&
      MEDIA_TYPES.includes(merged['type']) &&
      typeof merged['page_id'] === 'string'
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
  },
};
