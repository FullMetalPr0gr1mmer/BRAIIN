import type { ContactSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// The home contact band (HomeContact.astro, the `contact` type): a display line in two parts,
// the second set as the accent ("Let's make something <em>that lands</em>"). Its form's
// copy is the form's own (src/lib/forms/contactCopy.ts).

export const CONTACT_COPY: BuiltIn<ContactSectionContent, 'heading' | 'accent'> = {
  heading: { en: "Let's make something", ar: 'خلّنا نصنع شيئاً' },
  accent: { en: 'that lands', ar: 'يترك أثراً' },
};
