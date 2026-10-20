import { z } from 'zod';
import { ThemeTokensSchema } from './themeTokens';

// The preview bridge's envelope (Admin v2 R9, P-4; releases.md §6.3 item 9). The page editor
// (the parent, E2) frames `/admin/preview/**`; the two talk only in these messages, posted
// with an explicit same-origin targetOrigin and accepted only from the same origin AND the
// expected window (src/lib/admin/preview/bridge.ts, src/lib/admin/previewChannel.ts). Every
// message is parsed here first; anything else is dropped. Strict objects: a key this
// version does not know is refused, never carried along.
//
// Theme tokens are CSS custom properties only (CLAUDE.md §3, §7): ThemeTokensSchema holds
// both the name (`--…`) and the value (no `;`, braces, angle brackets or backslash), and the
// preview applies them with `style.setProperty`, never as markup.

export const PREVIEW_MESSAGE_VERSION = 1 as const;

/** What `data-pv-section` holds: a section's uuid, or `default-<n>` for a built-in one. */
export const PreviewSectionIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

/** A path inside the preview, as the bridge reports it. */
export const PreviewPathSchema = z
  .string()
  .max(2048)
  .regex(/^\/admin\/preview(?:[/?#]|$)/);

const v = z.literal(PREVIEW_MESSAGE_VERSION);
const y = z.number().finite().min(0).max(10_000_000);

/** Parent → preview. */
export const ToPreviewMessageSchema = z.discriminatedUnion('type', [
  z.object({ v, type: z.literal('jump'), sectionId: PreviewSectionIdSchema }).strict(),
  z
    .object({ v, type: z.literal('highlight'), sectionId: PreviewSectionIdSchema.nullable() })
    .strict(),
  z.object({ v, type: z.literal('scroll'), y }).strict(),
  z.object({ v, type: z.literal('reload') }).strict(),
  z
    .object({
      v,
      type: z.literal('tokens'),
      tokens: ThemeTokensSchema.refine((t) => Object.keys(t).length <= 200, 'too many tokens'),
    })
    .strict(),
]);
export type ToPreviewMessage = z.infer<typeof ToPreviewMessageSchema>;

/** Preview → parent. */
export const FromPreviewMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      v,
      type: z.literal('ready'),
      path: PreviewPathSchema,
      locale: z.enum(['en', 'ar']),
      sections: z
        .array(
          z
            .object({
              id: PreviewSectionIdSchema,
              anchor: z
                .string()
                .regex(/^[A-Za-z][\w-]{0,63}$/)
                .nullable(),
            })
            .strict(),
        )
        .max(200),
    })
    .strict(),
  z.object({ v, type: z.literal('scroll'), y }).strict(),
  z.object({ v, type: z.literal('navigate'), path: PreviewPathSchema }).strict(),
]);
export type FromPreviewMessage = z.infer<typeof FromPreviewMessageSchema>;
