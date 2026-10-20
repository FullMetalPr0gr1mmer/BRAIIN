import {
  FromPreviewMessageSchema,
  ToPreviewMessageSchema,
  type FromPreviewMessage,
  type ToPreviewMessage,
} from '@schemas/previewMessage';
import type { MessageEventLike, PostTarget } from './preview/bridge';

// The bridge's parent side (Admin v2 R9, P-4): what the page editor (E2) uses to talk to the
// `/admin/preview/**` page it frames. The same rules as the preview side
// (src/lib/admin/preview/bridge.ts): post to the frame's window with this origin as the
// targetOrigin, accept only messages from this origin AND from that frame's window that
// parse as the envelope (packages/schemas/previewMessage.ts).

/** A message from the framed preview, or null. */
export function acceptFromPreview(
  event: MessageEventLike,
  expected: { origin: string; source: unknown },
): FromPreviewMessage | null {
  if (event.origin !== expected.origin) return null;
  if (expected.source === null || expected.source === undefined) return null;
  if (event.source !== expected.source) return null;
  const parsed = FromPreviewMessageSchema.safeParse(event.data);
  return parsed.success ? parsed.data : null;
}

export interface PreviewChannel {
  /** Sends one message to the preview; false when it is invalid or the frame has no window. */
  send(message: ToPreviewMessage): boolean;
  /** Stops listening. */
  close(): void;
}

export interface ChannelHost {
  location: { origin: string };
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
}

/** Opens the channel to one framed preview. */
export function createPreviewChannel(
  frame: { contentWindow: PostTarget | null },
  host: ChannelHost,
  onMessage: (message: FromPreviewMessage) => void,
): PreviewChannel {
  const origin = host.location.origin;
  const listener = (event: MessageEventLike) => {
    const message = acceptFromPreview(event, { origin, source: frame.contentWindow });
    if (message) onMessage(message);
  };
  host.addEventListener('message', listener);
  return {
    send(message) {
      const target = frame.contentWindow;
      const parsed = ToPreviewMessageSchema.safeParse(message);
      if (!target || !parsed.success) return false;
      target.postMessage(parsed.data, origin);
      return true;
    },
    close() {
      host.removeEventListener('message', listener);
    },
  };
}
