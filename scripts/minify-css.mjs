// POST-build: strip comments and insignificant whitespace from the served stylesheets
// (dist/client/styles/**/*.css — public/styles is copied there verbatim; Vite never sees
// it).
//
// WHY. global.css is the one render-blocking request on every public page, and the web
// fonts cannot start until it has arrived: their @font-face rules live in it. Shipped as
// authored — its design rationale in comments, indented — it was 129 KB raw / 34.6 KB
// gzipped at UI v2 Round 2, of which ~59% was comments and indentation. On Lighthouse's
// mobile profile (1.6 Mbps, 150 ms RTT) every KB of it delayed the font chain, and the
// home LCP with it (measured: docs/design-port-2026-09.md, S2 performance note). The
// source keeps its comments; only the served copy loses them.
//
// SEMANTICS-PRESERVING BY CONSTRUCTION. This removes only what CSS syntax ignores:
//   - comments with whitespace on at least one side (each replaced by a space, then
//     collapsed into that whitespace);
//   - runs of whitespace, collapsed to one space;
//   - that space where it touches `{`, `}`, `;` or `,`, or follows a `:` (never
//     significant there — a space BEFORE a `:` is: `a :hover` is a descendant);
//   - the `;` right before a `}`.
// It never reorders, merges or rewrites a declaration, a selector or a value — unlike a
// full optimiser, it cannot change the cascade. Strings are copied byte for byte. It
// REFUSES (throws, failing the build) on anything outside that model: an unterminated
// string or comment, a comment glued to a token on both sides (CSS reads it as nothing,
// not as a space), or a backslash outside a string (an escape whose terminating space
// would need care). `tests/lib/minifyCss.spec.ts` proves every public stylesheet keeps
// every non-whitespace character, in order, and pins which spaces are kept (that check
// cannot see whitespace, so the space rules above are what the unit cases pin).
//
//   npm run build        → runs as part of `postbuild`
//   node scripts/minify-css.mjs [dir]   (default dist/client/styles)

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const BACKSLASH = '\\';
const TIGHT = '{};,';
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * Minify CSS text: comments and insignificant whitespace out, nothing else touched.
 * @param {string} css
 * @returns {string}
 */
export function minifyCss(css) {
  // Pass 1: comments → one space, whitespace runs → one space, strings verbatim.
  let spaced = '';
  for (let i = 0; i < css.length;) {
    const c = css[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c) {
        if (css[j] === '\n') throw new Error(`minifyCss: unterminated string at offset ${i}`);
        j += css[j] === BACKSLASH ? 2 : 1;
      }
      if (j >= css.length) throw new Error(`minifyCss: unterminated string at offset ${i}`);
      spaced += css.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end < 0) throw new Error(`minifyCss: unterminated comment at offset ${i}`);
      // A comment is NOT whitespace in CSS: `.a/**/.b` is the compound `.a.b`, and
      // `a/**/:hover` is `a:hover`. A space in its place would be a descendant combinator;
      // dropping it could merge two tokens (`1/**/2`). Only a comment with whitespace (or
      // the sheet's edge) on at least one side is modelled — there the space just joins
      // that whitespace. One glued on both sides is refused.
      const before = spaced[spaced.length - 1];
      const after = css[end + 2];
      if (before !== undefined && before !== ' ' && after !== undefined && !isSpace(after)) {
        throw new Error(
          `minifyCss: a comment glued between two tokens at offset ${i} is not supported`,
        );
      }
      if (!spaced.endsWith(' ')) spaced += ' ';
      i = end + 2;
    } else if (c === BACKSLASH) {
      throw new Error(`minifyCss: a backslash outside a string at offset ${i} is not supported`);
    } else if (isSpace(c)) {
      if (!spaced.endsWith(' ')) spaced += ' ';
      i += 1;
    } else {
      spaced += c;
      i += 1;
    }
  }

  // Pass 2: drop the space where it touches { } ; , or follows a : (and at either end),
  // and the `;` before a `}`. Strings are skipped again, so a quoted "a , b" keeps its bytes.
  let out = '';
  let quote = null;
  for (let k = 0; k < spaced.length; k++) {
    const c = spaced[k];
    if (quote) {
      out += c;
      if (c === BACKSLASH) out += spaced[++k] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === ' ') {
      const prev = out[out.length - 1];
      const next = spaced[k + 1];
      if (
        prev === undefined ||
        next === undefined ||
        TIGHT.includes(prev) ||
        TIGHT.includes(next) ||
        prev === ':'
      ) {
        continue;
      }
    }
    if (c === '}' && out.endsWith(';')) out = out.slice(0, -1);
    out += c;
  }
  return out;
}

/**
 * The token stream a stylesheet is made of, minus every comment and every whitespace
 * character outside strings (and the `;` before a `}`) — what minifyCss may remove. The
 * spec asserts minifyCss(x) and x reduce to the same one.
 * @param {string} css
 * @returns {string}
 */
export function significantChars(css) {
  let out = '';
  for (let i = 0; i < css.length;) {
    const c = css[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c) j += css[j] === BACKSLASH ? 2 : 1;
      out += css.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
    } else {
      if (!isSpace(c)) out += c;
      i += 1;
    }
  }
  return out.replace(/;}/g, '}');
}

/**
 * Every .css file under `dir`, as a path relative to it. Subdirectories count: the admin's
 * screen stylesheets are served from styles/admin/ (src/lib/admin/stylesheets.ts).
 */
export function cssFiles(dir, prefix = '') {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return cssFiles(dir, rel);
    return entry.name.endsWith('.css') ? [rel] : [];
  });
}

/** Minify every .css file under `dir` in place; returns what it did, per file. */
export function minifyDir(dir) {
  if (!existsSync(dir)) throw new Error(`minify-css: ${dir} not found — run the build first`);
  return cssFiles(dir).map((f) => {
    const path = join(dir, f);
    const src = readFileSync(path, 'utf8');
    const min = minifyCss(src);
    writeFileSync(path, min);
    return {
      file: f,
      before: Buffer.byteLength(src),
      after: Buffer.byteLength(min),
      gzBefore: gzipSync(src).length,
      gzAfter: gzipSync(min).length,
    };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] ?? 'dist/client/styles';
  for (const r of minifyDir(dir)) {
    console.log(
      `  ✓ ${dir}/${r.file}: ${r.before} → ${r.after} B (gzip ${r.gzBefore} → ${r.gzAfter} B)`,
    );
  }
}
