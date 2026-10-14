// All projects' catalogue (ProjectCatalog.astro, the `projectCatalog` type) takes no content
// and has no copy of its own: its projects are the portfolio table, and the words around
// them (the filter bar, "No projects match", "Clear filters") are FILTER_STR
// (src/lib/portfolio/filterText.ts), one copy shared with the in-page filter script. This
// module is here so every section type has one, and says so.

export const PROJECT_CATALOG_COPY = {} as const;
