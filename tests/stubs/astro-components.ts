import type { Plugin } from 'vitest/config';

// Lets a unit test import an `.astro` component and render it with Astro's container API
// (`experimental_AstroContainer` from astro/container), so a page's server-rendered markup
// can be asserted without a build or a browser: tests/lib/authPages.spec.ts renders the
// sign-in screens in states the CI preview never shows (Admin v2 F7: forgot password with
// e-mail set up, owner item O-2).
//
// It compiles the component the way Astro's own Vite plugin does (vite-plugin-astro: the
// same compiler, @astrojs/compiler-rs, a dependency of astro itself; the module is
// TypeScript, so the frontmatter's types are stripped by Vite), minus what a unit render
// does not use: no <style> preprocessing (a component with a <style> block is refused,
// not silently rendered without it) and no client scripts. `resolvePath` is what makes
// the compiler emit the runtime's current module shape (without it, a `$$createMetadata`
// import astro 7 no longer has).
//
// What a test renders is the component and whatever it imports. Anything that needs the
// real build (astro:assets, a database) is the test's to mock: the sign-in screens' layout
// is stubbed by tests/stubs/AuthLayout.astro.
//
// The compiler is loaded the first time an `.astro` file is transformed, never when the
// config loads: it is astro's dependency, not one of ours, so only a spec that renders a
// component depends on it, and a run without one never resolves it
// (tests/lib/astroComponentsPlugin.spec.ts).
export function astroComponents(): Plugin {
  return {
    name: 'braiin:astro-components-for-tests',
    enforce: 'pre',
    async transform(code, id) {
      const file = id.split('?')[0] ?? id;
      if (!file.endsWith('.astro')) return null;
      if (/<style[\s>]/i.test(code)) {
        throw new Error(`${file}: <style> blocks are not compiled for unit renders`);
      }
      const { transform } = await import('@astrojs/compiler-rs');
      const result = transform(code, {
        filename: file,
        internalURL: 'astro/compiler-runtime',
        sourcemap: 'external',
        resolvePath: (specifier) => specifier,
      });
      const error = result.diagnostics.find((d) => d.severity === 'error');
      if (error) throw new Error(`${file}: ${error.text}`);
      return { code: result.code, map: result.map || null, moduleType: 'ts' };
    },
  };
}
