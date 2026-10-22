// Island entry for the job applications screen (/admin/applications): the kit's DataTable
// and a wide drawer (Admin v2 U8a). Props: `canSeePii` (UX mirror of `applications.pii`),
// `initialStatus` and `openId` (the address's `?status=` and `?open=`, checked on the
// server). The page hydrates this entry; the screen's code is in screens/applications/.
export { default } from '@/components/admin/screens/applications/ApplicationsPanel';
