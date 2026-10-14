import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AVATAR_TONES, avatarTone, initialsOf } from '@/lib/admin/avatar';
import { initialsOf as shellInitials } from '@/lib/admin/shell';

// The avatar (Admin v2 F4b, AV-07 "avatar.spec"): a stable tone from a key and two letters.

describe('avatarTone', () => {
  it('is stable: the same key always gets the same tone', () => {
    const id = '7d0e8f1a-2b3c-4d5e-8f90-a1b2c3d4e5f6';
    expect(avatarTone(id)).toBe(avatarTone(id));
  });

  it('is the prototype’s hash (h × 31 + code, 32 bits) modulo eight', () => {
    // 'a' = 97 → 97 % 8 = 1; 'ab' = 97 × 31 + 98 = 3105 → 1; '' → 0.
    expect(avatarTone('a')).toBe(1);
    expect(avatarTone('ab')).toBe(3105 % 8);
    expect(avatarTone('')).toBe(0);
  });

  it('stays within the eight tones admin.css defines, and uses them all', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const tone = avatarTone(`user-${i}`);
      expect(tone).toBeGreaterThanOrEqual(0);
      expect(tone).toBeLessThan(AVATAR_TONES);
      seen.add(tone);
    }
    expect(seen.size).toBe(AVATAR_TONES);
  });

  it('every tone is styled, and each has an audited token', () => {
    const css = readFileSync(join(process.cwd(), 'public/styles/admin.css'), 'utf8');
    for (let tone = 0; tone < AVATAR_TONES; tone++) {
      expect(css).toMatch(new RegExp(`--ad-tone-${tone}:`));
      expect(css).toMatch(
        new RegExp(
          `\\.avatar\\[data-tone='${tone}'\\]\\s*\\{\\s*background:\\s*var\\(--ad-tone-${tone}\\)`,
        ),
      );
    }
  });
});

describe('initialsOf', () => {
  it('takes the first and last words’ first letters, or two letters of one word', () => {
    expect(initialsOf('Kareem Hassan Ali', 'k@example.com')).toBe('KA');
    expect(initialsOf('Sara', 's@example.com')).toBe('SA');
  });

  it('falls back to the e-mail', () => {
    expect(initialsOf(null, 'e2e-admin@example.com')).toBe('E2');
    expect(initialsOf('   ', 'dev@example.com')).toBe('DE');
  });

  it('keeps Arabic letters whole and as they are', () => {
    expect(initialsOf('كريم حسن', 'k@example.com')).toBe('كح');
  });

  it('never cuts a character made of two code units in half', () => {
    expect(initialsOf('𝒜da Lovelace', 'a@example.com')).toBe('𝒜L');
  });

  it('is the function the shell re-exports', () => {
    expect(shellInitials).toBe(initialsOf);
  });
});
