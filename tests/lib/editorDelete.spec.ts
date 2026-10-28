import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Delete from the service and project editors (Admin v2 U5/U6 review): main's ResourceTable
// rows carried "Delete <name>" for Admins; the new editors carry it now (editorDelete.ts).

const confirmDialog =
  vi.fn<(opts: { message: string; confirmLabel?: string }) => Promise<boolean>>();
const adminFetch = vi.fn<(url: string, init?: { method?: string }) => Promise<unknown>>();
vi.mock('@/lib/admin/confirm', () => ({ confirmDialog: (o: never) => confirmDialog(o) }));
vi.mock('@/lib/admin/client', () => ({
  adminFetch: (url: string, init?: { method?: string }) => adminFetch(url, init),
}));

const { afterDelete, deleteFromEditor, deleteMessage } = await import('@/lib/admin/editorDelete');
const { FLASH_MESSAGES, readFlash } = await import('@/lib/admin/flash');

const REQ = {
  slug: 'services',
  id: '8f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
  singular: 'Service',
  name: 'Logo design',
  back: '/admin/services',
  done: 'service-deleted' as const,
};

beforeEach(() => {
  confirmDialog.mockReset();
  adminFetch.mockReset();
});

describe('the words', () => {
  it('names the row in a bidi isolate, as the list always did', () => {
    expect(deleteMessage('Service', 'Logo design')).toBe(
      `Delete the service “${String.fromCodePoint(0x2068)}Logo design${String.fromCodePoint(0x2069)}”? This cannot be undone.`,
    );
  });

  it('has a confirmation for each delete and for a staged removal, with no dashes', () => {
    expect(FLASH_MESSAGES['service-deleted']).toBe('Service deleted');
    expect(FLASH_MESSAGES['project-deleted']).toBe('Project deleted');
    expect(FLASH_MESSAGES['removal-pending']).toBe('Will be removed when the release is published');
  });
});

describe('where it goes after the DELETE', () => {
  it('the list, saying it was deleted', () => {
    expect(readFlash(afterDelete(REQ, {}))).toEqual({
      message: 'Service deleted',
      rest: '/admin/services',
    });
  });

  it('the list, saying it waits for the release, when the kernel staged it', () => {
    expect(readFlash(afterDelete(REQ, { pendingRemoval: true }))?.message).toBe(
      'Will be removed when the release is published',
    );
  });
});

describe('deleteFromEditor', () => {
  it('asks first, then deletes the row and leaves through the editor (no "Leave site?")', async () => {
    confirmDialog.mockResolvedValue(true);
    adminFetch.mockResolvedValue({ deleted: REQ.id });
    const go = vi.fn();
    await expect(deleteFromEditor({ ...REQ, go })).resolves.toBe(true);
    expect(confirmDialog).toHaveBeenCalledWith({
      message: deleteMessage('Service', 'Logo design'),
      confirmLabel: 'Delete',
    });
    expect(adminFetch).toHaveBeenCalledWith(`/api/admin/services/${REQ.id}`, { method: 'DELETE' });
    expect(go).toHaveBeenCalledWith('/admin/services?done=service-deleted');
  });

  it('an editor in draft mode says so (R12b): a switch-off since is refused, never a live delete', async () => {
    confirmDialog.mockResolvedValue(true);
    adminFetch.mockResolvedValue({ deleted: REQ.id, pendingRemoval: true });
    await deleteFromEditor({ ...REQ, go: vi.fn(), staged: true });
    expect(adminFetch).toHaveBeenCalledWith(`/api/admin/services/${REQ.id}?staged=1`, {
      method: 'DELETE',
    });
    adminFetch.mockClear();
    await deleteFromEditor({ ...REQ, go: vi.fn(), staged: false });
    expect(adminFetch).toHaveBeenCalledWith(`/api/admin/services/${REQ.id}`, { method: 'DELETE' });
  });

  it('does nothing when the person cancels', async () => {
    confirmDialog.mockResolvedValue(false);
    const go = vi.fn();
    await expect(deleteFromEditor({ ...REQ, go })).resolves.toBe(false);
    expect(adminFetch).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
  });

  it('stays when the route refuses, and hands the error to the editor', async () => {
    confirmDialog.mockResolvedValue(true);
    adminFetch.mockRejectedValue(new Error('forbidden'));
    const go = vi.fn();
    await expect(deleteFromEditor({ ...REQ, go })).rejects.toThrow('forbidden');
    expect(go).not.toHaveBeenCalled();
  });
});

describe('the editors offer it to the roles that may archive and delete only', () => {
  const sources = {
    service: readFileSync('src/components/admin/screens/services/ServiceEditor.tsx', 'utf8'),
    project: readFileSync('src/components/admin/screens/projects/ProjectEditor.tsx', 'utf8'),
  };

  it.each(Object.entries(sources))(
    '%s editor: Delete under `archive`, left through save.leave',
    (_, src) => {
      expect(src).toMatch(
        /\{archive && \(\s*<button[^>]*?\s+data-variant="danger"[\s\S]*?Delete\s*<\/button>/,
      );
      expect(src).toMatch(/deleteFromEditor\(\{[\s\S]*?go: save\.leave,[\s\S]*?\}\)/);
    },
  );

  it('useEntitySave.leave skips the unsaved-changes question', () => {
    const src = readFileSync('src/lib/admin/useEntitySave.ts', 'utf8');
    expect(src).toMatch(/leave: useCallback\(\(href: string\) => \{\s*leaving\.current = true;/);
  });

  it('the list re-exports the same words', async () => {
    const list = await import('@/components/admin/screens/resources/ResourceTable');
    expect(list.deleteMessage).toBe(deleteMessage);
  });
});
