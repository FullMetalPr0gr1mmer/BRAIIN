import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio, contrastVerdict, formatContrast } from '@/lib/admin/contrast';

// The colour field's contrast line (Admin v2 F5a) uses src/lib/admin/contrast.ts; CI's gate
// is scripts/contrast-audit.mjs. Both must be the same maths, or the editor could pass a
// colour the gate fails. The script runs as a program (it exits), so its three functions
// are lifted out of its source and evaluated here, then compared pair by pair.

const SCRIPT = readFileSync(new URL('../../scripts/contrast-audit.mjs', import.meta.url), 'utf8');

function auditRatio(): (a: string, b: string) => number {
  const grab = (name: string) => {
    const start = SCRIPT.indexOf(`function ${name}(`);
    expect(start, `contrast-audit.mjs defines ${name}()`).toBeGreaterThan(-1);
    const end = SCRIPT.indexOf('\n}\n', start);
    return SCRIPT.slice(start, end + 2);
  };
  const source = `${grab('channel')}\n${grab('luminance')}\n${grab('ratio')}\nreturn ratio;`;
  return new Function(source)() as (a: string, b: string) => number;
}

const PAIRS: [string, string][] = [
  ['#ffffff', '#0024bc'],
  ['#0b0d14', '#f5f6fa'],
  ['#626a7f', '#ffffff'],
  ['#b54708', '#feefdd'],
  ['#22a9ff', '#000000'],
  ['#828b9e', '#fafbfe'],
  ['#000000', '#000000'],
  ['#ffffff', '#000000'],
];

describe('contrastRatio', () => {
  it('equals scripts/contrast-audit.mjs on sample pairs', () => {
    const audit = auditRatio();
    for (const [a, b] of PAIRS) {
      expect(contrastRatio(a, b), `${a} on ${b}`).toBeCloseTo(audit(a, b), 10);
      expect(contrastRatio(b, a)).toBeCloseTo(audit(a, b), 10);
    }
  });

  it('reads #RGB and any case, and is NaN for anything that is not a colour', () => {
    expect(contrastRatio('#FFF', '#000')).toBeCloseTo(21, 10);
    expect(contrastRatio('#0024BC', '#ffffff')).toBeCloseTo(contrastRatio('#0024bc', '#FFFFFF'));
    expect(contrastRatio('blue', '#ffffff')).toBeNaN();
    expect(contrastRatio('#12345', '#ffffff')).toBeNaN();
  });
});

describe('the words', () => {
  it('one decimal, never rounded up past a threshold', () => {
    expect(formatContrast(contrastRatio('#ffffff', '#0024bc'))).toMatch(/^\d+\.\d:1$/);
    expect(formatContrast(4.4999)).toBe('4.4:1');
    expect(formatContrast(21)).toBe('21.0:1');
    expect(formatContrast(Number.NaN)).toBe('');
  });

  it('says AA in words', () => {
    expect(contrastVerdict(4.5)).toBe('passes AA');
    expect(contrastVerdict(3.2)).toBe('passes AA for large text only');
    expect(contrastVerdict(2)).toBe('fails AA');
  });
});
