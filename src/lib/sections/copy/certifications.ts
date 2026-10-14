import type { LocalizedText } from '@schemas/content';

// The certifications list (Certifications.astro, the `certifications` type). It takes no
// content: the entries are the certifications table, and its heading is a fixed label.

export const CERTIFICATIONS_LABELS = {
  heading: { en: 'Certifications & partnerships', ar: 'الشهادات والشراكات' },
} as const satisfies Record<string, LocalizedText>;
