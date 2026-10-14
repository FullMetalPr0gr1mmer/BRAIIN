import { describe, expect, it, vi } from 'vitest';

// The vitest plugin that compiles `.astro` components for unit renders
// (tests/stubs/astro-components.ts) loads Astro's compiler, @astrojs/compiler-rs, only when
// it first transforms an `.astro` file. The compiler is astro's dependency, not one of ours,
// so the config, and every spec that renders no component, must not depend on it (F7 final
// review). The mock below counts each time the compiler module is loaded.

const compiler = vi.hoisted(() => ({ loads: 0 }));
vi.mock('@astrojs/compiler-rs', async (importOriginal) => {
  compiler.loads += 1;
  return importOriginal();
});

type Transform = (code: string, id: string) => Promise<{ code: string } | null>;

const COMPONENT = `---
const { name } = Astro.props;
---
<p>Hello {name}</p>
`;

describe('the .astro plugin loads the compiler only when it compiles a component', () => {
  it('loading the vitest config does not load it', async () => {
    const { default: config } = await import('../../vitest.config');
    expect(config.plugins?.length).toBeGreaterThan(0);
    expect(compiler.loads).toBe(0);
  });

  it('nor does transforming anything that is not an .astro file', async () => {
    const { astroComponents } = await import('../stubs/astro-components');
    const transform = astroComponents().transform as Transform;
    expect(await transform('export const x = 1;', '/src/x.ts')).toBeNull();
    expect(await transform('{}', '/src/x.astro.json')).toBeNull();
    expect(compiler.loads).toBe(0);
  });

  it('the first .astro file loads it, once', async () => {
    const { astroComponents } = await import('../stubs/astro-components');
    const transform = astroComponents().transform as Transform;
    const first = await transform(COMPONENT, '/src/Hello.astro');
    expect(first?.code).toContain('createComponent');
    await transform(COMPONENT, '/src/Again.astro?astro');
    expect(compiler.loads).toBe(1);
  });
});
