import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import * as M from '../../scripts/minify-css.mjs';

// scripts/minify-css.mjs strips comments and insignificant whitespace from the SERVED
// stylesheets (dist/client/styles) in `postbuild`. It exists for the render-blocking
// global.css (Round 2 S2 perf fix: the /ar home LCP). These tests pin that it removes
// only what CSS syntax ignores — never a byte the cascade can see.

const { cssFiles, minifyCss, significantChars } = M as unknown as {
  cssFiles: (dir: string) => string[];
  minifyCss: (css: string) => string;
  significantChars: (css: string) => string;
};

describe('minifyCss', () => {
  it('drops comments and collapses whitespace', () => {
    expect(minifyCss('/* head */\n.a {\n  color: red; /* why */\n}\n')).toBe('.a{color:red}');
  });

  it('collapses a comment into the whitespace beside it', () => {
    expect(minifyCss('.a /* x */.b{x:y}')).toBe('.a .b{x:y}');
    expect(minifyCss('.a/* x */ .b{x:y}')).toBe('.a .b{x:y}');
    expect(minifyCss('/* head */.a{x:y}')).toBe('.a{x:y}');
  });

  it('refuses a comment glued to a token on both sides: CSS reads it as nothing', () => {
    // `.a/**/.b` is the compound `.a.b` and `a/**/:hover` is `a:hover` — a space in the
    // comment's place would make each a descendant selector.
    expect(() => minifyCss('.a/**/.b{x:y}')).toThrow(/comment glued/);
    expect(() => minifyCss('a/* state */:hover{x:y}')).toThrow(/comment glued/);
  });

  it('drops the space only where it touches { } ; , or follows a :', () => {
    expect(minifyCss('a , b {\n  x: 1px ,  2px ;\n  y: z\n}\n')).toBe('a,b{x:1px,2px;y:z}');
  });

  it('keeps every significant space: combinators, calc operators, media keywords', () => {
    expect(minifyCss('.a .b > .c:hover {x:y}')).toBe('.a .b > .c:hover{x:y}');
    // a space BEFORE a colon is a descendant combinator — it stays
    expect(minifyCss('.a :focus-visible{x:y}')).toBe('.a :focus-visible{x:y}');
    expect(minifyCss('.a{width:calc(100% - 2 * var(--g))}')).toBe(
      '.a{width:calc(100% - 2 * var(--g))}',
    );
    expect(minifyCss('@media screen and (max-width: 900px) { .a { x: y } }')).toBe(
      '@media screen and (max-width:900px){.a{x:y}}',
    );
    expect(minifyCss('.a{margin:0 auto;transition:opacity .3s ease , transform 1s}')).toBe(
      '.a{margin:0 auto;transition:opacity .3s ease,transform 1s}',
    );
  });

  it('copies strings byte for byte, comment-like text and escaped quotes included', () => {
    const src = `.a::before{content:"/* not a comment */  ;  , {"}\n[dir='rtl'] .b{x:y}\n.c{content:'it\\'s  x'}`;
    expect(minifyCss(src)).toBe(
      `.a::before{content:"/* not a comment */  ;  , {"}[dir='rtl'] .b{x:y}.c{content:'it\\'s  x'}`,
    );
  });

  it('is idempotent', () => {
    const once = minifyCss('.a {\n color : red ;\n}\n/* x */ .b , .c { y: z }');
    expect(minifyCss(once)).toBe(once);
  });

  it('refuses what it does not model, rather than guess', () => {
    expect(() => minifyCss('.a{x:y} /* open')).toThrow(/unterminated comment/);
    expect(() => minifyCss('.a{content:"open}')).toThrow(/unterminated string/);
    expect(() => minifyCss('.a\\31 {x:y}')).toThrow(/backslash/);
  });
});

describe('every public stylesheet', () => {
  const dir = join(process.cwd(), 'public/styles');
  // Every sheet under public/styles, the admin's screen sheets (admin/) included.
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.css'))
    .map((f) => f.split(sep).join('/'));

  it('includes global.css', () => {
    expect(files).toContain('global.css');
  });

  it('includes the admin screen sheets, and the build visits every one', () => {
    expect(files).toContain('admin/login.css');
    expect([...cssFiles(dir)].sort()).toEqual([...files].sort());
  });

  for (const f of files) {
    it(`${f} minifies to the same token stream, and shrinks`, () => {
      const src = readFileSync(join(dir, f), 'utf8');
      const min = minifyCss(src);
      expect(significantChars(min)).toBe(significantChars(src));
      expect(min.length).toBeLessThan(src.length);
      expect(min).not.toMatch(/\/\*/);
    });
  }
});

describe('the build runs it', () => {
  it('postbuild minifies dist/client/styles before the origin check', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.postbuild).toMatch(/^node scripts\/minify-css\.mjs && /);
  });
});
