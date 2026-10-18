import type { AuthContext } from '@/lib/auth/types';
import { can } from '@/lib/authz/matrix';
import {
  collectionOf,
  type CollectionDef,
} from '@/components/admin/screens/collection/collections';
import type { CollectionPermissions } from '@/components/admin/screens/collection/fields';
import { RESOURCES } from './resources';

// What a collection page (Admin v2 U7: /admin/<slug>, /new, /[id]) decides on the server
// before the AdminCollection island draws it: the page head's title and line, and what the
// role may do (the buttons only: Add, Edit, Delete, the order; every API route checks the
// capability again). The capabilities are the resource's own: its write capability in full,
// and its delete capability (content.archiveDelete unless the resource names another).

export interface CollectionScreen {
  def: CollectionDef;
  title: string;
  sub: string;
  permissions: CollectionPermissions;
  /** The drawer that opens with the page, or null; `notFound` for an id that cannot be one. */
  open: string | null;
  notFound: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function collectionScreen(
  session: AuthContext | null,
  slug: string,
  open: 'new' | string | null = null,
): CollectionScreen {
  const def = collectionOf(slug);
  const config = RESOURCES[slug];
  if (!config) throw new Error(`no resource "${slug}"`);
  const role = session?.role;
  const permissions: CollectionPermissions = {
    write: role !== undefined && can(role, config.writeCap) === 'full',
    remove: role !== undefined && can(role, config.deleteCap ?? 'content.archiveDelete') === 'full',
  };
  // An id that is not a uuid is no item of the list: the page answers 404 and opens nothing.
  const notFound = open !== null && open !== 'new' && !UUID.test(open);
  return {
    def,
    title: def.title,
    sub: def.sub,
    permissions,
    open: notFound || (open === 'new' && !permissions.write) ? null : open,
    notFound,
  };
}
