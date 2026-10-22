import { useMemo } from 'react';
import Note from '@/components/admin/kit/Note';
import EditorForm from '@/components/admin/fields/EditorForm';
import type { NotificationSwitch } from '@/lib/admin/notificationSettings';
import type { FieldDef } from '@/lib/admin/uiSchema';
import { useEntitySave } from '@/lib/admin/useEntitySave';

// /admin/settings/notifications's island (Admin v2 U11; the prototype's "In-admin
// notifications" card, as A1 leaves it: the bell only, no e-mail, WhatsApp or Slack): one
// switch per kind of item the person's role gets, named on the server (the page hands the
// switches over, so the form is known before its row loads). Saved by useEntitySave as a
// singleton against the person's own preferences, so a save made in another tab is a 409 with
// "Reload their version", never overwritten.

export const NOTIFICATION_SETTINGS_ENDPOINT = '/api/admin/me/notification-settings';

/**
 * The prototype's card head (screens_ops.js:
 * `card('In-admin notifications', 'The bell at the top', …)`).
 */
export const NOTIFICATION_SETTINGS_CARD = {
  title: 'In-admin notifications',
  sub: 'The bell at the top',
} as const;

export interface NotificationSettingsScreenProps {
  switches: readonly NotificationSwitch[];
}

export default function NotificationSettingsScreen({ switches }: NotificationSettingsScreenProps) {
  // One array for the island's life: a new one would reload the row and drop the changes.
  const fields = useMemo<FieldDef[]>(
    () => switches.map((s) => ({ name: s.kind, label: s.label, kind: 'checkbox', help: s.hint })),
    [switches],
  );
  const save = useEntitySave(
    { kind: 'singleton', endpoint: NOTIFICATION_SETTINGS_ENDPOINT },
    null,
    { fields },
  );
  return (
    <EditorForm save={save} fields={fields} submitLabel="Save" heading={NOTIFICATION_SETTINGS_CARD}>
      <Note>
        Turning one off only quiets the bell. Everything still shows on its own screen, and the
        admin sends no e-mail or WhatsApp messages.
      </Note>
    </EditorForm>
  );
}
