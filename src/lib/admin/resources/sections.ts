import { SectionUpdateSchema, SectionWriteSchema } from '@schemas/admin';
import { sectionContentIssues, type SectionType } from '@schemas/sections';
import { isSampleRating } from '@/lib/sections/samples';
import { ValidationError } from '../errors';
import type { ResourceConfig } from '../resource';
import { pick, type Input } from './shared';

// Page sections: content typed per section type (packages/schemas/sections.ts).

export const sectionResource: ResourceConfig = {
  table: 'page_sections',
  // A visible section on a published page is live copy, so turning `visible` on is gated
  // as a publish (content.publish). Every role that may edit sections holds it today; the
  // flag keeps the two capabilities from drifting apart unnoticed.
  publishFlag: 'visible',
  entity: 'page_section',
  writeCap: 'pages.write',
  listColumns: 'id,page_id,type,visible,sort_order,version,updated_at',
  columns:
    'id,page_id,type,content,visible,sort_order,is_placeholder,version,created_at,updated_at',
  orderBy: { column: 'sort_order', ascending: true },
  filterableColumns: ['page_id'],
  createSchema: SectionWriteSchema,
  updateSchema: SectionUpdateSchema,
  // `style` is deliberately absent: it is no longer writable (see SectionWriteSchema).
  toRow: (input) =>
    pick(input as Input, {
      pageId: 'page_id',
      type: 'type',
      content: 'content',
      visible: 'visible',
      sortOrder: 'sort_order',
      isPlaceholder: 'is_placeholder',
    }),
  // The schema validates content only when a payload carries BOTH type and content. A
  // PATCH of content alone (or of type alone) is checked here, against the type the row
  // will have — otherwise it saves "fine" and the loader silently drops it.
  assertWritable: (merged, { changed }) => {
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
  },
};
