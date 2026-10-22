import { describe, expect, it } from 'vitest';
import { MAINTENANCE_DEFAULTS, type MaintenanceSnapshot } from '@schemas/maintenance';
import {
  MAINTENANCE_POSTER,
  SCRIM_ALPHA,
  SCRIM_RGB,
  backOnDate,
  escapeHtml,
  maintenancePage,
} from '@/lib/maintenance/page';
import { DEFAULT_MESSAGE, DEFAULT_TITLE } from '@/lib/maintenance/copy';

// The maintenance page (Admin v2 U9b), as visitors get it: bilingual by the route, the
// admin's copy or the built-in words that match its buttons, every text escaped, styles only
// in the one nonced <style>, no script, the date in our own month words (Arabic-Indic digits in
// Arabic), the buttons only when on (WhatsApp only with a number), and a scrim dark enough for
// white words on the worst still: a white one.

const NOW = Date.parse('2026-10-20T09:00:00Z');
const NONCE = 'bm9uY2UtMTIz';
const BRAND = { en: 'Studio', ar: 'استوديو' };

const page = (patch: Partial<MaintenanceSnapshot> = {}, locale: 'en' | 'ar' = 'en') =>
  maintenancePage({
    nonce: NONCE,
    snapshot: { ...MAINTENANCE_DEFAULTS, active: true, ...patch },
    locale,
    now: NOW,
    logoSrc: '/_image?href=%2F_astro%2Flogo.png&w=264&h=135&f=webp',
    fallbackBrand: BRAND,
  });

const contact = (patch: Partial<MaintenanceSnapshot['contact']> = {}) => ({
  brand: { en: 'Braiin', ar: 'بريّن' },
  email: 'hello@example.test',
  whatsappE164: '+966500000001',
  ...patch,
});

describe('the words', () => {
  it('the built-in headline and the message that matches the buttons, in both languages', () => {
    expect(page({ showContact: true, contact: contact() })).toContain(
      escapeHtml(DEFAULT_MESSAGE.emailAndWhatsapp.en),
    );
    expect(page({ showContact: true, contact: contact({ whatsappE164: null }) })).toContain(
      escapeHtml(DEFAULT_MESSAGE.email.en),
    );
    expect(page({ showContact: false, contact: contact() })).toContain(
      escapeHtml(DEFAULT_MESSAGE.none.en),
    );
    expect(page({}, 'en')).toContain(`<h1>${escapeHtml(DEFAULT_TITLE.en)}</h1>`);
    const ar = page({ showContact: false }, 'ar');
    expect(ar).toContain('<html lang="ar" dir="rtl">');
    expect(ar).toContain(`<h1>${DEFAULT_TITLE.ar}</h1>`);
    expect(ar).toContain(DEFAULT_MESSAGE.none.ar);
  });

  it('the admin’s copy wins, escaped wherever it lands', () => {
    const evil = '<script>alert("x")</script>&\'';
    const html = page({
      copy: { title: { en: evil, ar: evil }, message: { en: evil, ar: evil } },
      contact: { ...contact(), brand: { en: evil, ar: evil } },
      showContact: true,
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;');
  });

  it('the brand from the snapshot, else the code fallback', () => {
    expect(page({ contact: contact() })).toContain(
      '<title>We&#39;re making something new. | Braiin</title>',
    );
    expect(page({ contact: { brand: null, email: null, whatsappE164: null } })).toContain(
      '| Studio</title>',
    );
  });
});

describe('"Back on" (D10)', () => {
  it('only when asked and set, in our own month words', () => {
    expect(
      page({ showDate: true, until: '2026-11-03', untilAt: '2026-11-02T21:00:00Z' }),
    ).toContain('<p class="when">Back on 3 November</p>');
    expect(
      page({ showDate: false, until: '2026-11-03', untilAt: '2026-11-02T21:00:00Z' }),
    ).not.toContain('class="when"');
    expect(page({ showDate: true, until: null })).not.toContain('class="when"');
  });

  it('Arabic: Arabic-Indic digits through the footer’s helper, Gregorian month names', () => {
    expect(backOnDate('2026-11-03', 'ar', NOW)).toBe('٣ نوفمبر');
    expect(backOnDate('2027-01-02', 'ar', NOW)).toBe('٢ يناير ٢٠٢٧');
    expect(backOnDate('2027-01-02', 'en', NOW)).toBe('2 January 2027');
    expect(backOnDate('nope', 'en', NOW)).toBeNull();
    expect(
      page({ showDate: true, until: '2026-11-03', untilAt: '2026-11-02T21:00:00Z' }, 'ar'),
    ).toContain('نعود في ٣ نوفمبر');
  });
});

describe('the buttons', () => {
  it('email and WhatsApp when on; WhatsApp only with a number; none when off', () => {
    const both = page({ showContact: true, contact: contact() });
    expect(both).toContain('href="mailto:hello@example.test"');
    expect(both).toContain('href="https://wa.me/966500000001"');
    const noWa = page({ showContact: true, contact: contact({ whatsappE164: null }) });
    expect(noWa).toContain('mailto:');
    expect(noWa).not.toContain('wa.me');
    const off = page({ showContact: false, contact: contact() });
    expect(off).not.toContain('mailto:');
    expect(off).not.toContain('class="contact"');
  });

  it('Arabic words on the Arabic page', () => {
    const html = page({ showContact: true, contact: contact() }, 'ar');
    expect(html).toContain('>راسلنا</a>');
    expect(html).toContain('>واتساب</a>');
  });
});

describe('under the strict CSP', () => {
  it('one nonced <style>, no style attribute, no script, fonts and the still from this origin', () => {
    const html = page({ showContact: true, contact: contact(), background: 'image' });
    expect(html.match(/<style/g)).toHaveLength(1);
    expect(html).toContain(`<style nonce="${NONCE}">`);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toContain('<script');
    expect(html).toContain(`url('${MAINTENANCE_POSTER}')`);
    expect(html).toContain("url('/fonts/archivo-var-latin.woff2')");
    expect(html).not.toMatch(/url\(['"]?https?:/);
    expect(html).not.toContain('.mp4');
    expect(html).toContain('<body class="bg-image">');
    expect(page({ background: 'black' })).toContain('<body class="bg-black">');
  });

  it('a nonce outside the base64 alphabet is cut to it', () => {
    const html = maintenancePage({
      nonce: 'abc"><script>',
      snapshot: MAINTENANCE_DEFAULTS,
      locale: 'en',
      now: NOW,
      logoSrc: null,
      fallbackBrand: BRAND,
    });
    expect(html).toContain('<style nonce="abcscript">');
    expect(html).not.toContain('<img');
  });
});

describe('the scrim meets AA for white words over a WHITE still (the worst case)', () => {
  const lum = ([r, g, b]: number[]) => {
    const c = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * c(r!) + 0.7152 * c(g!) + 0.0722 * c(b!);
  };
  const ratio = (a: number[], b: number[]) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  const ground = SCRIM_RGB.map((v) => Math.round(v * SCRIM_ALPHA + 255 * (1 - SCRIM_ALPHA)));

  it('white text, and the date’s sky tint', () => {
    expect(ratio([255, 255, 255], ground)).toBeGreaterThanOrEqual(4.5);
    expect(ratio([0xa8, 0xc2, 0xff], ground)).toBeGreaterThanOrEqual(4.5);
  });
});
