// `tsc --noEmit` has no Astro plugin, so a .ts spec that imports a component
// (tests/render, rendered through the container API) needs the module typed. `astro check`
// resolves the real component and never falls back to this.
declare module '*.astro' {
  import type { AstroComponentFactory } from 'astro/runtime/server/index.js';

  const Component: AstroComponentFactory;
  export default Component;
}
