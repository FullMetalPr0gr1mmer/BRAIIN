// Island entry for every collection's create and edit screens (/admin/<slug>/new and
// /admin/<slug>/[id]): a pre-F1 panel in the F3 shape (Admin v2 W0). The pages hydrate this
// entry; the screen's code is in screens/resources/. Admin v2 U8b: a page may also pass
// `readOnly`, `initialTab`, `seoAccess` and `seo` (the SEO tab's setup), all decided on the
// server from ROLE_CAPS (ResourceForm.tsx).
export { default } from '@/components/admin/screens/resources/ResourceForm';
