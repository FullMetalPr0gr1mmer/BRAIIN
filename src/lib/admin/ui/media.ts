import type { ResourceUi } from './types';

// Media library: the list and the form at /admin/media.
export const mediaUi: ResourceUi = {
  slug: 'media',
  title: 'Media library',
  singular: 'Asset',
  columns: [
    { key: 'storage_path', label: 'Path' },
    { key: 'kind', label: 'Kind' },
    { key: 'alt', label: 'Alt text', kind: 'bilingual' },
    { key: 'created_at', label: 'Added', kind: 'date' },
  ],
  fields: [
    {
      name: 'kind',
      label: 'Kind',
      kind: 'select',
      options: [
        { value: 'image', label: 'Image' },
        { value: 'video', label: 'Video' },
        { value: 'audio', label: 'Audio' },
        { value: 'pdf', label: 'PDF' },
      ],
      required: true,
    },
    { name: 'storagePath', label: 'Storage path', kind: 'text', required: true },
    { name: 'folder', label: 'Folder', kind: 'text' },
    {
      name: 'alt',
      label: 'Alt text',
      kind: 'bilingual',
      help: 'Required for images — WCAG 2.2 AA is a definition-of-done gate.',
    },
    { name: 'tags', label: 'Tags', kind: 'tags' },
    { name: 'width', label: 'Width (px)', kind: 'number' },
    { name: 'height', label: 'Height (px)', kind: 'number' },
    { name: 'streamUid', label: 'Cloudflare Stream UID', kind: 'text' },
  ],
};
