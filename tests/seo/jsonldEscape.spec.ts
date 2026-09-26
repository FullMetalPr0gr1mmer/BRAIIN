import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { serializeForScript } from '@/lib/seo/serialize';
import { buildFaqSchema } from '@/lib/seo/jsonld';

// JsonLd.astro emits its payload with `set:html` inside <script type="application/ld+json">.
// A bare JSON.stringify there lets any CMS string close the element early. These assert
// the escape and — as importantly — that the component actually uses it.

// Built, not typed: a literal U+2028 is invisible in review (see serialize.ts).
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

describe('serializeForScript', () => {
  it('cannot be broken out of with </script>', () => {
    const out = serializeForScript({
      quote: 'nice</script><meta http-equiv="refresh" content="0;url=https://evil.example">',
    });
    expect(out).not.toMatch(/<\/script/i);
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });

  it('neutralises HTML comment openers and closers', () => {
    const out = serializeForScript({ a: '<!-- x -->' });
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('-->');
  });

  it('escapes & and the JS line terminators U+2028 / U+2029', () => {
    const out = serializeForScript({ a: `R&D${LS}next${PS}end` });
    expect(out).not.toContain('&');
    expect(out).not.toContain(LS);
    expect(out).not.toContain(PS);
  });

  it('round-trips to the identical value (the escapes are JSON-standard)', () => {
    const value = {
      name: 'Braiin <Statiion> & co',
      nested: [{ q: `</script>${LS}` }, 1, true, null],
      ar: 'بريّن ستيشن',
    };
    expect(JSON.parse(serializeForScript(value))).toEqual(value);
  });

  it('round-trips a real JSON-LD node carrying hostile CMS text', () => {
    // FAQ answers are CMS-authored prose — exactly the kind of string that can hold `</script>`.
    const node = buildFaqSchema([{ question: 'Q?</script>', answer: `A <b>&</b> ${LS}` }]);
    const out = serializeForScript(node);
    expect(out).not.toMatch(/<\/script/i);
    expect(JSON.parse(out)).toEqual(node);
  });

  it('embeds null, not the text "undefined", for unserialisable input', () => {
    expect(serializeForScript(undefined)).toBe('null');
  });
});

describe('JsonLd.astro', () => {
  it('serialises through serializeForScript, never a bare JSON.stringify', () => {
    const src = readFileSync(new URL('../../src/components/JsonLd.astro', import.meta.url), 'utf8');
    expect(src).toContain('serializeForScript(');
    expect(src).not.toMatch(/JSON\.stringify\(/);
  });
});
