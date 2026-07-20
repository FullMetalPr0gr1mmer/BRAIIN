import { describe, it, expect } from 'vitest';
import { SystemLogEntrySchema } from '@schemas/systemLog';

// system_logs is an append-only sink written on ERROR paths — exactly when a runaway loop
// or an attacker-influenced string shows up. The caps are the security property here.

describe('SystemLogEntrySchema', () => {
  it('accepts a minimal entry', () => {
    expect(SystemLogEntrySchema.safeParse({ level: 'error', message: 'boom' }).success).toBe(true);
  });

  it('accepts the full entry with source + detail', () => {
    const parsed = SystemLogEntrySchema.safeParse({
      level: 'warn',
      message: 'slow query',
      source: 'search',
      detail: { ms: 812, rows: 20 },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown level', () => {
    expect(SystemLogEntrySchema.safeParse({ level: 'fatal', message: 'x' }).success).toBe(false);
  });

  it('rejects an empty message — a blank log line is noise, not a record', () => {
    expect(SystemLogEntrySchema.safeParse({ level: 'info', message: '' }).success).toBe(false);
  });

  it('caps message length so one bad caller cannot flood the table', () => {
    const ok = { level: 'error' as const, message: 'x'.repeat(2000) };
    const tooLong = { level: 'error' as const, message: 'x'.repeat(2001) };
    expect(SystemLogEntrySchema.safeParse(ok).success).toBe(true);
    expect(SystemLogEntrySchema.safeParse(tooLong).success).toBe(false);
  });

  it('caps source length', () => {
    const entry = (n: number) => ({ level: 'info' as const, message: 'm', source: 's'.repeat(n) });
    expect(SystemLogEntrySchema.safeParse(entry(120)).success).toBe(true);
    expect(SystemLogEntrySchema.safeParse(entry(121)).success).toBe(false);
  });
});
