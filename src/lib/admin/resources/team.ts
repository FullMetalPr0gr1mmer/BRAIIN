import { TeamMemberUpdateSchema, TeamMemberWriteSchema } from '@schemas/admin';
import type { ResourceConfig } from '../resource';
import { pick, refusePlaceholder, requireBilingual, statusOf, type Input } from './shared';

// Team members: the About page's people and the blog's authors (E-E-A-T).

export const teamResource: ResourceConfig = {
  table: 'team_members',
  entity: 'team_member',
  writeCap: 'blog.write',
  readCaps: ['blog.write', 'services.write', 'seo.entityMeta'],
  listColumns:
    'id,slug,name,role,is_leadership,is_placeholder,status,sort_order,version,updated_at',
  columns:
    'id,slug,name,bio,avatar_url,profile_user_id,role,linkedin_url,is_leadership,portrait_media_id,' +
    'is_placeholder,status,sort_order,version,created_at,updated_at',
  orderBy: { column: 'sort_order', ascending: true },
  searchColumn: 'slug',
  createSchema: TeamMemberWriteSchema,
  updateSchema: TeamMemberUpdateSchema,
  toRow: (input) =>
    pick(input as Input, {
      slug: 'slug',
      name: 'name',
      bio: 'bio',
      avatarUrl: 'avatar_url',
      profileUserId: 'profile_user_id',
      role: 'role',
      linkedinUrl: 'linkedin_url',
      isLeadership: 'is_leadership',
      portraitMediaId: 'portrait_media_id',
      isPlaceholder: 'is_placeholder',
      status: 'status',
      sortOrder: 'sort_order',
    }),
  statusOf: (input) => statusOf(input as Input),
  constraintFields: {
    team_members_linkedin_url_check: {
      field: 'linkedinUrl',
      message: 'a https://linkedin.com/in/… or /company/… address',
    },
  },
  assertPublishable: (row) => {
    requireBilingual(row, 'name', 'Name');
    refusePlaceholder(row, 'team member');
  },
};
