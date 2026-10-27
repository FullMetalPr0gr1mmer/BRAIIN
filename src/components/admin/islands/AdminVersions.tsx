import { ClockProvider } from '@/components/admin/kit/clock';
import { LIVE_VERSIONS_API } from '@/components/admin/screens/versions/api';
import Versions from '@/components/admin/screens/versions/Versions';
import type { OpenRestore } from '@/lib/release/versionsPage';
import type { VersionSummary } from '@/lib/release/versions';

// Backups & versions' versions card (Admin v2 R13): one island, drawn by /admin/backups only
// while releases are on (with them off the page says so, with no script). Its code is the
// `admin-versions` chunk (astro.config.mjs), which no other screen loads; it reuses the publish
// dialog's schedule rules from `admin-release`, which every screen already loads while releases
// are on. The dates are the studio's clock, the server's zone (`tz`), so the server render and
// the hydrated one print the same strings.

export interface AdminVersionsProps {
  tz: string;
  versions: VersionSummary[];
  upcoming: VersionSummary[];
  restores: Record<string, OpenRestore>;
  more: boolean;
}

export default function AdminVersions({ tz, ...rest }: AdminVersionsProps) {
  return (
    <ClockProvider tz={tz}>
      <Versions api={LIVE_VERSIONS_API} {...rest} />
    </ClockProvider>
  );
}
