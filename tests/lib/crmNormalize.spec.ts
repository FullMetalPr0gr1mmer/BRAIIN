import { describe, it, expect } from 'vitest';
import { emailDomain, isFreemail, normalizeEmail, normalizePhone } from '@/lib/crm/normalize';

// Normalisation feeds the blind indexes (Admin v2 C1b): two spellings of one address must
// give one index, and nothing that might be a different person may be folded together.

describe('normalizeEmail', () => {
  it('folds case, surrounding space and Unicode compatibility forms', () => {
    expect(normalizeEmail('  Sara.Q@Example.COM ')).toBe('sara.q@example.com');
    // Fullwidth characters (NFKC) read as their ASCII twins.
    expect(normalizeEmail('ｓａｒａ@example.com')).toBe('sara@example.com');
  });

  it('writes an international domain in its ASCII (punycode) form', () => {
    expect(normalizeEmail('info@münchen.de')).toBe('info@xn--mnchen-3ya.de');
  });

  it('does not fold gmail dots or plus tags: they may be different people', () => {
    expect(normalizeEmail('s.ara+work@gmail.com')).toBe('s.ara+work@gmail.com');
    expect(normalizeEmail('sara@gmail.com')).not.toBe(normalizeEmail('s.ara@gmail.com'));
  });

  it('refuses what is not one address', () => {
    for (const bad of [
      '',
      'sara',
      '@example.com',
      'sara@',
      'sa ra@example.com',
      'sara@localhost',
    ]) {
      expect(normalizeEmail(bad), bad).toBeNull();
    }
  });

  it('knows free mailbox providers', () => {
    expect(isFreemail('sara@gmail.com')).toBe(true);
    expect(isFreemail('sara@outlook.sa')).toBe(true);
    expect(isFreemail('sara@acme.sa')).toBe(false);
    expect(emailDomain('sara@acme.sa')).toBe('acme.sa');
  });
});

describe('normalizePhone', () => {
  it('reads Saudi local numbers as E.164', () => {
    expect(normalizePhone('050 123 4567', 'SA')).toBe('+966501234567');
    expect(normalizePhone('0501234567', 'SA')).toBe('+966501234567');
    expect(normalizePhone('501234567', 'SA')).toBe('+966501234567');
    expect(normalizePhone('966501234567', 'SA')).toBe('+966501234567');
  });

  it('reads Arabic-Indic and Persian digits', () => {
    expect(normalizePhone('٠٥٠١٢٣٤٥٦٧', 'SA')).toBe('+966501234567');
    expect(normalizePhone('۰۵۰۱۲۳۴۵۶۷', 'SA')).toBe('+966501234567');
  });

  it('keeps international numbers, with + or 00', () => {
    expect(normalizePhone('+971 50 123 4567', 'SA')).toBe('+971501234567');
    expect(normalizePhone('00971501234567', 'SA')).toBe('+971501234567');
    expect(normalizePhone('(+44) 20-7946-0958', 'SA')).toBe('+442079460958');
  });

  it('gives up rather than guess', () => {
    expect(normalizePhone('12345', 'SA')).toBeNull();
    expect(normalizePhone('call me', 'SA')).toBeNull();
    expect(normalizePhone('0501234567', 'ZZ')).toBeNull();
    // The nine-digit mobile rule is a Saudi and Emirati habit, not a general one.
    expect(normalizePhone('501234567', 'EG')).toBeNull();
    expect(normalizePhone('+12', 'SA')).toBeNull();
  });
});
