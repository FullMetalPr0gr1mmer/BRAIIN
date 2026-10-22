// Island entry for every collection's list screen (/admin/<slug>): a pre-F1 panel in the
// F3 shape (Admin v2 W0). The pages hydrate this entry; the screen's code is in
// screens/resources/. Admin v2 U8b: a page may pass `canCreate` (the role's write
// capability, from ROLE_CAPS on the server) to leave out "New".
export { default } from '@/components/admin/screens/resources/ResourceTable';
