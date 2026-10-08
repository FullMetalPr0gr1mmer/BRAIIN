import {
  PortfolioUpdateSchema,
  PortfolioWriteSchema,
  type PortfolioMediaItem,
} from '@schemas/admin';
import type { VideoClip } from '@schemas/media';
import { NotFoundError, OptimisticLockError, ValidationError } from '../errors';
import { getRow, translateWriteError, type ConstraintFields } from '../crud';
import type { ResourceConfig } from '../resource';
import {
  bySortOrder,
  clipColumns,
  clipOfColumns,
  pick,
  publishStamp,
  refusePlaceholder,
  refusePlaceholderFigures,
  requireBilingual,
  statusOf,
  withBodyHtml,
  type Input,
} from './shared';

// Portfolio: a case study, saved with its services and media in one transaction (0022).

/** A media item as the form edits it (camelCase) → one element of save_portfolio's p_media. */
function mediaItemToRow(item: PortfolioMediaItem): Input {
  const clip = item.clip ?? null;
  return {
    role: item.role,
    kind: item.kind,
    media_id: item.mediaId ?? null,
    video_uid: clip?.streamUid ?? null,
    video_path: clip?.path ?? null,
    clip_start_s: clip?.startS ?? null,
    clip_end_s: clip?.endS ?? null,
    duration_label: item.durationLabel ?? null,
    caption: item.caption ?? null,
    breakdown_kind: item.breakdownKind ?? null,
    layout: item.layout ?? null,
  };
}

/** A stored portfolio_media row → the form's item. */
function mediaRowToItem(row: Input): Input {
  const item: Input = { role: row['role'], kind: row['kind'] };
  if (row['media_id']) item['mediaId'] = row['media_id'];
  const clip = clipOfColumns(
    row['video_uid'],
    row['video_path'],
    row['clip_start_s'],
    row['clip_end_s'],
  );
  if (clip) item['clip'] = clip;
  if (row['duration_label']) item['durationLabel'] = row['duration_label'];
  if (row['caption']) item['caption'] = row['caption'];
  if (row['breakdown_kind']) item['breakdownKind'] = row['breakdown_kind'];
  if (row['layout']) item['layout'] = row['layout'];
  return item;
}

const PORTFOLIO_CONSTRAINTS: ConstraintFields = {
  portfolio_tenant_id_slug_key: {
    field: 'slug',
    message: 'another case study already uses this slug',
  },
  portfolio_slug_not_reserved: {
    field: 'slug',
    message: '“all” is reserved for the All projects page',
  },
  portfolio_preview_window: {
    field: 'preview',
    message: 'the hover clip needs a start and an end, at most 30 seconds apart',
  },
  portfolio_next_not_self: {
    field: 'nextPortfolioId',
    message: 'a case study cannot be its own next project',
  },
  portfolio_media_one_hero: { field: 'media', message: 'a case study has one hero item at most' },
  portfolio_media_one_final: { field: 'media', message: 'a case study has one final film at most' },
  portfolio_services_pkey: { field: 'serviceIds', message: 'a service is listed twice' },
  portfolio_media_breakdown_kind: {
    field: 'media',
    message: 'a breakdown item needs its kind (sketch / BTS / process); other items none',
  },
};

export const portfolioResource: ResourceConfig = {
  table: 'portfolio',
  entity: 'portfolio',
  writeCap: 'portfolio.write',
  readCaps: ['portfolio.write', 'seo.entityMeta'],
  listColumns:
    'id,slug,title,project_type,year,is_featured,is_placeholder,status,sort_order,version,updated_at',
  // The child sets ride along as embeds so the form loads them with the row; fromRow
  // turns them into `service_ids` / `media` in the order the editor gave.
  columns:
    'id,slug,title,summary,body,body_html,status,sort_order,version,published_at,scheduled_for,' +
    'created_at,updated_at,project_type,teaser,lead,goal,result,scope,keywords,results,' +
    'sector_id,client_id,year,is_featured,poster_media_id,preview_video_uid,preview_video_path,' +
    'preview_start_s,preview_end_s,next_portfolio_id,is_placeholder,' +
    'portfolio_services(service_id,sort_order),' +
    'portfolio_media(role,kind,media_id,video_uid,video_path,clip_start_s,clip_end_s,' +
    'duration_label,caption,breakdown_kind,layout,sort_order)',
  orderBy: { column: 'sort_order', ascending: true },
  searchColumn: 'slug',
  filterableColumns: ['is_featured', 'sector_id', 'client_id'],
  createSchema: PortfolioWriteSchema,
  updateSchema: PortfolioUpdateSchema,
  constraintFields: PORTFOLIO_CONSTRAINTS,
  toRow: (input) => {
    const values = publishStamp(
      withBodyHtml(
        pick(input as Input, {
          slug: 'slug',
          title: 'title',
          summary: 'summary',
          body: 'body',
          status: 'status',
          sortOrder: 'sort_order',
          scheduledFor: 'scheduled_for',
          projectType: 'project_type',
          teaser: 'teaser',
          lead: 'lead',
          goal: 'goal',
          result: 'result',
          scope: 'scope',
          keywords: 'keywords',
          results: 'results',
          sectorId: 'sector_id',
          clientId: 'client_id',
          year: 'year',
          isFeatured: 'is_featured',
          posterMediaId: 'poster_media_id',
          nextPortfolioId: 'next_portfolio_id',
          isPlaceholder: 'is_placeholder',
        }),
        input as Input,
      ),
    );
    const preview = (input as Input)['preview'];
    return preview === undefined
      ? values
      : { ...values, ...clipColumns((preview as VideoClip | null) ?? null, 'preview_', 'video') };
  },
  statusOf: (input) => statusOf(input as Input),
  // A case study and its services + media are ONE save (save_portfolio(), migration
  // 0022): SECURITY INVOKER so RLS applies to every row it writes, version-checked, and
  // every linked id fenced to the caller's tenant. The previous afterWrite replaced the
  // services in a second request — a failure there left a half-saved case study.
  childKeys: ['serviceIds', 'media'],
  persist: async ({ auth, sb, id, version, values, input }) => {
    const serviceIds = input['serviceIds'];
    const media = input['media'];
    const { data, error } = await sb.rpc('save_portfolio', {
      p_id: id,
      p_version: version,
      p_values: values,
      p_service_ids: Array.isArray(serviceIds) ? serviceIds : null,
      p_media: Array.isArray(media) ? (media as PortfolioMediaItem[]).map(mediaItemToRow) : null,
    });
    if (error) {
      if (error.code === '40001') throw new OptimisticLockError('portfolio');
      if (error.code === 'P0002') throw new NotFoundError('portfolio');
      throw translateWriteError(error, 'portfolio', 'write', PORTFOLIO_CONSTRAINTS);
    }
    const saved = (Array.isArray(data) ? data[0] : data) as { id?: string } | undefined;
    if (!saved?.id) throw new Error('save_portfolio returned no row');
    return getRow<Input>(sb, 'portfolio', auth, saved.id, portfolioResource.columns);
  },
  fromRow: (row) => {
    const { portfolio_services: links, portfolio_media: items, ...rest } = row;
    const out: Input = {
      ...rest,
      preview: clipOfColumns(
        row['preview_video_uid'],
        row['preview_video_path'],
        row['preview_start_s'],
        row['preview_end_s'],
      ),
    };
    if (Array.isArray(links)) {
      out['service_ids'] = [...(links as Input[])].sort(bySortOrder).map((l) => l['service_id']);
    }
    if (Array.isArray(items)) {
      out['media'] = [...(items as Input[])].sort(bySortOrder).map(mediaRowToItem);
    }
    return out;
  },
  // What a card and a case study need to be presentable — the public pages show these.
  assertPublishable: async (row, { auth, sb }) => {
    requireBilingual(row, 'title', 'Case study title');
    requireBilingual(row, 'project_type', 'Project type');
    refusePlaceholder(row, 'case study');
    refusePlaceholderFigures(row);
    const posterId = row['poster_media_id'];
    if (!posterId)
      throw new ValidationError('choose a poster image before publishing', 'posterMediaId');
    const { data } = await sb
      .from('media_assets')
      .select('alt')
      .eq('tenant_id', auth.tenantId)
      .eq('id', String(posterId))
      .maybeSingle();
    const alt = (data?.['alt'] ?? {}) as Record<string, unknown>;
    if (!alt['en'] || !alt['ar']) {
      throw new ValidationError(
        'the poster needs alt text in English and Arabic before publishing',
        'posterMediaId',
      );
    }
  },
};
