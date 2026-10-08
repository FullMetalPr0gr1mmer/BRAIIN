# W0-c: admin registries (as built)

Wave 0's admin half: the files every later admin slice would otherwise edit become
registries, so a slice adds a module and one line instead of editing shared lines. A
refactor only: no screen, route, API response or public page changes.

## What was built

- **The menu, one module per area.** `src/lib/admin/nav.ts` became `src/lib/admin/nav/`.
  Each sidebar group is a module (`overview`, `content`, `crm`, `hiring`, `growth`,
  `appearance`, `settings`) holding its title, its place (`order`, in tens) and its links.
  `nav/index.ts` composes `NAV_AREAS`, sorted by `order`, into `ADMIN_NAV`, and keeps
  `isVisible`, `visibleNav`, `reachableHrefs`, `currentLink` and `currentTab` as they were.
  A screen is a link or a tab in its area's module; a new area is a module and one line in
  `NAV_AREAS`.
- **The head counts, a registry.** The counts left `shell.ts` for `src/lib/admin/counters/`
  (`leads`, `applications`: the same HEAD queries), registered in `COUNTERS`. `NavCount` is
  the registry's key type, so a link can only name a registered count, and `shell.ts` still
  runs a counter only for a link the role sees.
- **Resource configs, one module per entity.** `src/lib/admin/resources.ts` became
  `resources/<entity>.ts` (20 entities), with the mapping helpers and go-live rules in
  `resources/shared.ts`. `resources/index.ts` re-exports every config by name and adds
  `RESOURCES` (slug to config). Each route under `src/pages/api/admin/` imports its own
  entity's module, so it loads one config instead of twenty.
- **Editors, one module per entity.** The descriptors in `uiSchema.ts` moved to
  `src/lib/admin/ui/`: the shapes in `ui/types.ts`, the shared helpers in `ui/fields.ts`,
  one module per collection editor and per singleton. `ui/index.ts` builds `RESOURCE_UI`
  from each editor's own `slug` and holds `SINGLETON_UI`, `uiFor` and `singletonFor`.
  `uiSchema.ts` stays the import path and re-exports `ui/`.
- **Screen stylesheets.** What only one screen renders lives in
  `public/styles/admin/<screen>.css` (today `login.css` and `search.css`), linked after
  admin.css through AdminLayout's `styles` prop: a closed list in
  `src/lib/admin/stylesheets.ts`, so a typo fails `astro check`. The minifier walks
  subfolders, the contrast gate refuses a screen sheet that declares an `--ad-*` token, and
  `tests/lib/adminStyles.spec.ts` holds the list equal to the files, keeps colour literals,
  tokens, font faces and motion blocks out of the sheets, and fails a page that renders a
  sheet's classes without linking it.
- **Islands.** The nine pre-F1 islands are `Admin*` entries in
  `src/components/admin/islands/`, each re-exporting its screen from
  `src/components/admin/screens/<name>/`. `.size-limit.json` and
  `scripts/admin-bundle.mjs` go by the `Admin*` name and list no island one by one. Every
  admin screen's eager graph measured 14 B gz below the build before Wave 0.
- **Tests that pin the registries.** `adminNav.spec` pins the seven areas and their
  places; `adminShell.spec` pins the counters to the counts the menu shows;
  `adminResources.spec` and `adminRoutes.spec` derive their maps from `RESOURCES` and pin
  the 20 slugs and 5 singletons; `adminConventions.spec` requires every hydrated island to
  be an `Admin*` entry from `islands/`, refuses a module beside a registry folder under its
  name (`@/lib/admin/nav` would resolve to a `nav.ts` before `nav/index.ts`), and checks
  that every admin path CLAUDE.md names exists.

## Moves

| Before | After |
|---|---|
| `src/lib/admin/nav.ts` | `src/lib/admin/nav/<area>.ts`, composed in `nav/index.ts`, shapes in `nav/types.ts` |
| `COUNTERS` in `src/lib/admin/shell.ts` | `src/lib/admin/counters/<count>.ts`, registered in `counters/index.ts` |
| `src/lib/admin/resources.ts` | `src/lib/admin/resources/<entity>.ts` and `shared.ts`, `RESOURCES` in `index.ts` |
| the body of `src/lib/admin/uiSchema.ts` | `src/lib/admin/ui/<entity>.ts`, `types.ts`, `fields.ts`, registries in `index.ts` |
| the sign-in and search rules in `public/styles/admin.css` | `public/styles/admin/login.css`, `public/styles/admin/search.css` |
| `src/components/admin/LeadsPanel.tsx` | `islands/AdminLeads.tsx` over `screens/leads/LeadsPanel.tsx` |
| `src/components/admin/ApplicationsPanel.tsx` | `islands/AdminApplications.tsx` over `screens/applications/ApplicationsPanel.tsx` |
| `src/components/admin/UsersPanel.tsx` | `islands/AdminUsers.tsx` over `screens/users/UsersPanel.tsx` |
| `src/components/admin/InsightsPanel.tsx` | `islands/AdminInsights.tsx` over `screens/insights/InsightsPanel.tsx` |
| `src/components/admin/MaintenancePanel.tsx` | `islands/AdminMaintenance.tsx` over `screens/maintenance/MaintenancePanel.tsx` |
| `src/components/admin/ReadOnlyPanel.tsx` | `islands/AdminLogs.tsx` over `screens/logs/ReadOnlyPanel.tsx` |
| `src/components/admin/ResourceTable.tsx`, `ResourceForm.tsx` | `islands/AdminResourceTable.tsx`, `AdminResourceForm.tsx` over `screens/resources/` |
| `src/components/admin/SingletonForm.tsx` | `islands/AdminSingletonForm.tsx` over `screens/singleton/SingletonForm.tsx` |

`islands/` and `screens/` are under `src/components/admin/`.

## Departures from the design, and why

- **No pending links and no topbar slots.** The plan's amendment of 2026-10-05 lists
  "nav with pending links pre-declared" and "topbar slots" for this slice; its brief left
  both out. The menu declares only today's screens, and a slice adds its link to its
  area's module. The topbar is unchanged, so the slices that add to it (the bell in F8,
  help in U16) each edit `src/components/admin/ui/Topbar.astro`: merge them one at a time.
- **`sectionUi.ts` is not split per section type.** The unit of the split is the entity;
  the section editor's per-type field lists stay one map (`SECTION_UI`), held to the
  section schemas by `tests/lib/sectionUi.spec.ts`.
- **Moved screens keep their component names.** An `Admin*` entry re-exports its screen's
  default export, and the screens moved unchanged, so `LeadsPanel`, `ResourceForm` and the
  others keep their names. The slices that rebuild those screens rename what they replace.
- **The bar stays in admin.css.** `.bar`, `.bar-fill`, its 5% `data-width` buckets and the
  forced-colours fill are the admin's one way to draw a bar, a progress or a score width
  (ui.md §1.2 and §1.6; the lead score bar in crm.md), so they are a design-system hook
  rather than a screen's rule. A first cut moved them into an `insights.css` because only
  the insight panels draw one today; that was undone, and `adminStyles.spec` now pins the
  §1.2 hooks and the whole bar to admin.css.
