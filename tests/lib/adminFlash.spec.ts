import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLASH_MESSAGES, FLASH_PARAM, readFlash, withFlash } from '@/lib/admin/flash';

// Confirmations that outlive a navigation (Admin v2 C4b, src/lib/admin/flash.ts). A toast
// fired just before location.assign goes with the page, unseen and unheard; the address
// carries a key from a closed list instead, and the next page shows it once.

const LEAD = '44444444-4444-4444-8444-444444444444';
const OLD = '55555555-5555-4555-8555-555555555555';

describe('withFlash and readFlash', () => {
  it('adds the key to a bare path and to one with a query, before any fragment', () => {
    expect(withFlash('/admin/leads', 'lead-erased')).toBe('/admin/leads?done=lead-erased');
    expect(withFlash(`/admin/leads/${LEAD}?same=${OLD}`, 'lead-added')).toBe(
      `/admin/leads/${LEAD}?same=${OLD}&done=lead-added`,
    );
    expect(withFlash('/admin/leads#top', 'lead-erased')).toBe('/admin/leads?done=lead-erased#top');
  });

  it('reads the message back and gives the address without the key', () => {
    expect(readFlash(withFlash('/admin/leads', 'lead-erased'))).toEqual({
      message: 'Lead erased',
      rest: '/admin/leads',
    });
    expect(readFlash(withFlash(`/admin/leads/${LEAD}?same=${OLD}`, 'lead-added'))).toEqual({
      message: 'Lead added',
      rest: `/admin/leads/${LEAD}?same=${OLD}`,
    });
  });

  it('says nothing for an address with no key, and never words an address brings', () => {
    expect(readFlash('/admin/leads?range=30')).toBeNull();
    // An unknown key (a crafted link) is taken out and shows nothing.
    expect(readFlash('/admin/leads?done=You+won+a+prize&range=30')).toEqual({
      message: null,
      rest: '/admin/leads?range=30',
    });
    expect(readFlash('/admin/leads?done=toString')).toEqual({
      message: null,
      rest: '/admin/leads',
    });
    expect(FLASH_PARAM).toBe('done');
    for (const words of Object.values(FLASH_MESSAGES)) expect(words).not.toMatch(/[–—]/);
  });
});

describe('the leads screens', () => {
  const read = (file: string) =>
    readFileSync(`src/components/admin/screens/leads/${file}`, 'utf8').replace(/\r\n/g, '\n');

  it('never toast just before they leave the page; the address carries the confirmation', () => {
    for (const [file, key] of [
      ['AddLeadDrawer.tsx', 'lead-added'],
      ['EraseLeadDialog.tsx', 'lead-erased'],
    ] as const) {
      const source = read(file);
      expect(source, file).not.toMatch(/\btoast\(/);
      expect(source, file).toContain(`'${key}'`);
      expect(source, file).toMatch(/location\.assign\(\s*withFlash\(/);
    }
  });

  it('show it on the page they land on, before the list rewrites its address', () => {
    for (const file of ['LeadsList.tsx', 'LeadDetail.tsx']) {
      expect(read(file), file).toContain('useEffect(() => showFlash(), []);');
    }
    const list = read('LeadsList.tsx');
    expect(list.indexOf('useEffect(() => showFlash(), []);')).toBeLessThan(
      list.indexOf('history.replaceState(null'),
    );
  });
});
