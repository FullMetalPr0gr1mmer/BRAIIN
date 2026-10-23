import type { Role } from '@/lib/auth/types';
import { LIVE_RELEASE_API } from '@/components/admin/screens/release/api';
import ReleaseUi from '@/components/admin/screens/release/ReleaseUi';

// The savebar and the publish dialog (Admin v2 R12): one island, rendered by AdminLayout only
// when the shell read releases on for the tenant (and never for Sales), so with releases off
// neither its markup nor its script reaches a page. Its code is the `admin-release` chunk
// (astro.config.mjs), which no other admin screen loads.

export interface AdminSavebarProps {
  role: Role;
}

export default function AdminSavebar({ role }: AdminSavebarProps) {
  return <ReleaseUi api={LIVE_RELEASE_API} role={role} />;
}
