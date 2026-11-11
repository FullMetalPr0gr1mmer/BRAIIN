import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ContactFilesCard from '@/components/admin/screens/contacts/ContactFilesCard';
import { erasedFilesLine } from '@/components/admin/screens/contacts/EraseContactDialog';
import { defaultFileName, fileKindLabel, fileProblem, fileSize } from '@/lib/crm/fileView';
import { CRM_FILE_ACCEPT } from '@schemas/crmFiles';

// The Files card on a contact's page (Admin v2 C16): its first render (no `style=`, the file
// input labelled and described, the virus-scan warning in words, nothing read before the page
// asks), the browser's courtesy checks (size, name), its words, the page handing it to
// crm.files holders only and the island loading it with import() only, and the erasure's
// line for the files.

const card = () =>
  renderToStaticMarkup(
    createElement(ContactFilesCard, {
      contactId: '22222222-2222-4222-8222-222222222222',
      people: new Map(),
      onChanged: () => undefined,
    }),
  );

describe('the Files card’s first render', () => {
  it('says it is loading, and that files are not virus-scanned; no inline style', () => {
    const html = card();
    expect(html).toContain('Files</h2>');
    expect(html).toContain('Files are not virus-scanned. Open them in an up-to-date app.');
    expect(html).toContain('Loading the files…');
    expect(html).not.toMatch(/\sstyle=/);
    // The add form waits for the list (the ceiling is known only then).
    expect(html).not.toContain('type="file"');
    // A live region for "File added." / "File removed.".
    expect(html).toContain('role="status"');
  });
});

describe('the card’s words and checks', () => {
  it('names the kinds and sizes in plain words', () => {
    expect(fileKindLabel('application/pdf')).toBe('PDF');
    expect(
      fileKindLabel('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('Word document');
    expect(fileKindLabel('image/webp')).toBe('WebP image');
    expect(fileKindLabel('text/html')).toBe('File');
    expect(fileSize(2048)).toBe('2 KB');
    expect(fileSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
    expect(fileSize(0)).toBe('');
  });

  it('starts a name from the file’s own, without a folder or a control character', () => {
    expect(defaultFileName('C:\\Users\\x\\Brief.pdf')).toBe('Brief.pdf');
    expect(defaultFileName('a/b/عقد.docx')).toBe('عقد.docx');
    expect(defaultFileName('bad\u0007name.png')).toBe('badname.png');
    expect(defaultFileName('x'.repeat(200))).toHaveLength(120);
  });

  it('refuses before sending: no file, empty, over 10 MB, a name with a slash', () => {
    expect(fileProblem(null, 'a')).toEqual({ field: 'file', message: 'Choose a file first.' });
    expect(fileProblem({ size: 0 }, 'a')?.message).toBe('This file is empty.');
    expect(fileProblem({ size: 10 * 1024 * 1024 + 1 }, 'a')?.message).toBe(
      'This file is larger than 10 MB. Choose a smaller one.',
    );
    expect(fileProblem({ size: 10 }, 'a/b')).toEqual({
      field: 'name',
      message: 'A file name cannot hold a slash.',
    });
    expect(fileProblem({ size: 10 }, '   ')?.field).toBe('name');
    expect(fileProblem({ size: 10 }, 'Brief.pdf')).toBeNull();
  });

  it('offers the five kinds and nothing else in the picker', () => {
    expect(CRM_FILE_ACCEPT).not.toMatch(/svg|html|zip|\.doc,/);
    expect(CRM_FILE_ACCEPT).toContain('.docx');
  });

  it('the erasure says how many files go', () => {
    expect(erasedFilesLine(1)).toBe('Their 1 file goes too, removed from storage first.');
    expect(erasedFilesLine(3)).toBe('Their 3 files go too, removed from storage first.');
  });

  it('keeps the admin copy rules: no em or en dash', () => {
    const source = readFileSync(
      'src/components/admin/screens/contacts/ContactFilesCard.tsx',
      'utf8',
    );
    const view = readFileSync('src/lib/crm/fileView.ts', 'utf8');
    for (const text of [source, view, readFileSync('packages/schemas/crmFiles.ts', 'utf8')]) {
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe('a contact’s page carries the Files card for crm.files holders (C16)', () => {
  const island = readFileSync('src/components/admin/screens/contacts/ContactDetail.tsx', 'utf8');
  const page = readFileSync('src/pages/admin/contacts/[id].astro', 'utf8');

  it('the island loads it with import() only when the page says so', () => {
    expect(island).toMatch(/if \(!props\.files\) return;\s*import\('\.\/ContactFilesCard'\)/);
    expect(island).toContain('{props.files && FilesCard ? (');
    expect(island).not.toMatch(/^import\s+(?!type\b)[^;]*ContactFilesCard/m);
  });

  it('the page hands it to crm.files holders only', () => {
    expect(page).toContain(
      "const canFiles = allowed && can(session.role, 'crm.files') === 'full';",
    );
    expect(page).toContain('files={canFiles}');
  });
});
