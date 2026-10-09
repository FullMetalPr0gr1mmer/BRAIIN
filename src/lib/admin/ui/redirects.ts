import type { ResourceUi } from './types';

// Redirects: the list and the form at /admin/redirects.
export const redirectsUi: ResourceUi = {
  slug: 'redirects',
  title: 'Redirects',
  singular: 'Redirect',
  columns: [
    { key: 'source_path', label: 'From' },
    { key: 'target_path', label: 'To' },
    { key: 'status', label: 'Code' },
  ],
  // Every save and delete rebuilds the edge snapshot (design-port R3-1); the button is
  // for the first snapshot after a deploy and for a retry after "the edge did not pick
  // it up". The status line beside it is the one place the two counts are compared.
  syncAction: { endpoint: '/api/admin/redirects/sync', label: 'Sync to edge' },
  fields: [
    {
      name: 'sourcePath',
      label: 'From (site-relative)',
      kind: 'text',
      required: true,
      help: 'The old path, e.g. /old-page (no ?query or #fragment; /old and /old/ are the same rule). A rule applies only where nothing renders: a path that answers a page today — a static route, or a live service, project or post — is refused, and /ar/… falls back to the English rule automatically.',
    },
    {
      name: 'targetPath',
      label: 'To',
      kind: 'text',
      required: true,
      help: 'A site-relative path (/new-page, /services#branding — a ?query is allowed) or an https:// URL. Point at the final destination: a target that is itself redirected is refused (no chains), and so is a rule pointing at its own /ar twin.',
    },
    {
      name: 'status',
      label: 'HTTP status',
      kind: 'select',
      options: [
        { value: '301', label: '301 — permanent' },
        { value: '302', label: '302 — temporary' },
        { value: '308', label: '308 — permanent, method-preserving' },
      ],
      help: 'Takes effect at the edge within a minute of saving. Browsers may keep a permanent redirect (301, 308) for up to a day; a temporary one (302) is never cached, so it can be changed or removed at once.',
    },
  ],
};
