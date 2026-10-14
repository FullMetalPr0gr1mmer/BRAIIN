// `tsc --noEmit` reads tests/ but not .astro files: Astro's own checker (`astro check`)
// resolves an `.astro` import to its component, and plain tsc needs this wildcard to accept
// the import at all. The specs here render those components with Astro's container API,
// whose `renderToString` takes an AstroComponentFactory.
declare module '*.astro' {
  const Component: import('astro/runtime/server/index.js').AstroComponentFactory;
  export default Component;
}
