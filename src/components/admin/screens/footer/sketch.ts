import { copyrightLine } from '@/lib/appearance/copyright';

// The Footer screen's sketch (Admin v2 E6), pure so it is unit-tested
// (tests/lib/footerScreen.spec.ts): what the footer would show in English, drawn from the
// Basics form as it is (before it is saved) and the identity row it read (the site name, the
// place, the mailbox, the accounts shown), with the columns card's titles. Closed values only:
// the screen draws them with classes and one data-* attribute (CSP: no style attribute).

type Row = Readonly<Record<string, unknown>>;

/** What the sketch needs from the identity row (General's fields, read with the footer's). */
export interface SketchFacts {
  brand: string;
  place: string;
  email: string;
  /** How many accounts are set to Show on the site. */
  socials: number;
}

const en = (value: unknown): string => {
  if (value && typeof value === 'object') {
    const v = (value as Row)['en'];
    return typeof v === 'string' ? v : '';
  }
  return '';
};

/** The facts from the singleton's row (null before it is read). */
export function sketchFacts(row: Row | null): SketchFacts {
  const socials = Array.isArray(row?.['socials'])
    ? (row['socials'] as unknown[]).filter(
        (s) => s && typeof s === 'object' && (s as Row)['visible'] !== false,
      ).length
    : 0;
  return {
    brand: en(row?.['brand_name']) || 'Site name',
    place: en(row?.['location']) || 'Location',
    email: typeof row?.['contact_email'] === 'string' ? (row['contact_email'] as string) : '',
    socials,
  };
}

export interface FooterSketch {
  style: 'light' | 'dark';
  copyright: string;
  /** The mailbox, or '' when it is hidden (or unknown). */
  email: string;
  /** Up to four column titles. */
  columns: string[];
  /** How many icons, 0 when they are hidden. */
  socials: number;
}

/** The sketch from the form's values (the field names of src/lib/admin/ui/footer.ts). */
export function footerSketch(
  values: Row,
  facts: SketchFacts,
  columns: readonly string[],
): FooterSketch {
  const template = en(values['footerCopyright']);
  return {
    style: values['footerStyle'] === 'dark' ? 'dark' : 'light',
    // A blank template is the built-in line, as on the site.
    copyright: copyrightLine({ en: template, ar: '' }, 'en', {
      year: String(new Date().getFullYear()),
      brand: facts.brand,
      place: facts.place,
    }),
    email: values['footerShowEmail'] === false ? '' : facts.email,
    columns: columns.slice(0, 4),
    socials: values['footerShowSocial'] === true ? facts.socials : 0,
  };
}
