import { z } from 'zod';
import { UuidSchema } from './primitives';

// Two-step sign-in (Admin v2 U17): what the /admin/2fa page's forms carry. The page is zero JS,
// so every value arrives as a form field; each is held to its shape here before anything acts
// on it. Nothing in these forms is ever echoed into a URL or a log.

/** Arabic-Indic (U+0660..0669) and Extended Arabic-Indic (U+06F0..06F9) digits, to ASCII. */
function asciiDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/**
 * The 6-digit code an authenticator app shows. Spaces are dropped (apps show "123 456"), and a
 * keypad's Arabic-Indic digits are read as the digits they are: the code is not content, so
 * the admin's rule of never changing digits (P-12) is about what people write, not this.
 */
export const TotpCodeSchema = z
  .string()
  .max(32)
  .transform((value) => asciiDigits(value).replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Type the 6-digit code from your app.'));

/** A factor's id, as GoTrue gives it. */
export const FactorIdSchema = UuidSchema;

/**
 * The setup key (the TOTP secret, base32), as GoTrue returns it and the setup step carries it
 * back in a hidden field so a wrong code re-renders the same key. It is the person's own, on
 * the page already; GoTrue verifies against its own copy, so a tampered value only shows its
 * tamperer a wrong key.
 */
export const SetupKeySchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z2-7]{16,128}=*$/));

/** The page's form intents. */
export const TWO_STEP_INTENTS = ['verify', 'start', 'confirm', 'off', 'signout'] as const;
export type TwoStepIntent = (typeof TWO_STEP_INTENTS)[number];
export const TwoStepIntentSchema = z.enum(TWO_STEP_INTENTS);
