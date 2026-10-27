import { adminFetch } from '@/lib/admin/client';
import type { PurgeRetryResult, ReleaseStatusAnswer } from '@schemas/release';
import PublishCard from '@/components/admin/screens/release/PublishCard';

// The dashboard's "Publish status" card (Admin v2 R13): drawn by the dashboard's publish widget
// only while releases are on (with them off the widget is not on the board at all, and no
// request is made). Its code is in the `admin-release` chunk group with the savebar, which every
// screen loads while releases are on (astro.config.mjs).

const load = () => adminFetch<ReleaseStatusAnswer>('/api/admin/releases/status');
const retry = (id: string) =>
  adminFetch<PurgeRetryResult>(`/api/admin/releases/${encodeURIComponent(id)}/purge`, {
    method: 'POST',
    body: {},
  });

export default function AdminPublishCard() {
  return <PublishCard load={load} retry={retry} />;
}
