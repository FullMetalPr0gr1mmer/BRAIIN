import { describe, it, expect } from 'vitest';
import { sniffCv, hasExternalRelationship } from '@/lib/applications/fileSniff';

// Real bytes, not mocks: a minimal ZIP writer (stored or deflated entries; CRCs are not
// checked by the sniff, so they are zero) builds each .docx case, and the PDFs are their
// smallest valid shape. Every refusal reason the endpoint can map to `bad_type` is here.

const enc = new TextEncoder();

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface Part {
  name: string;
  text: string;
  deflate?: boolean;
  flags?: number;
}

async function zip(parts: Part[], opts: { comment?: string } = {}): Promise<Blob> {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = enc.encode(part.name);
    const raw = enc.encode(part.text);
    const data = part.deflate ? await deflateRaw(raw) : raw;
    const method = part.deflate ? 8 : 0;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, part.flags ?? 0, true);
    lh.setUint16(8, method, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, raw.length, true);
    lh.setUint16(26, name.length, true);
    locals.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, part.flags ?? 0, true);
    ch.setUint16(10, method, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, raw.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const comment = enc.encode(opts.comment ?? '');
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, parts.length, true);
  eocd.setUint16(10, parts.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  eocd.setUint16(20, comment.length, true);
  return new Blob([...locals, ...central, new Uint8Array(eocd.buffer), comment] as BlobPart[]);
}

const CONTENT_TYPES = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const DOC_RELS = (rels: string) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;

const docx = (extra: Part[] = [], over: Partial<Record<string, string>> = {}) =>
  zip([
    { name: '[Content_Types].xml', text: over['types'] ?? CONTENT_TYPES, deflate: true },
    { name: 'word/document.xml', text: '<w:document/>', deflate: true },
    {
      name: 'word/_rels/document.xml.rels',
      text:
        over['rels'] ??
        DOC_RELS(
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
        ),
      deflate: true,
    },
    ...extra,
  ]);

describe('sniffCv — PDF', () => {
  it('accepts a PDF: %PDF- at the start, %%EOF at the end', async () => {
    const pdf = new Blob([enc.encode('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')]);
    expect(await sniffCv(pdf)).toEqual({ ok: true, kind: 'pdf' });
  });

  it('refuses a truncated PDF (no %%EOF in the tail)', async () => {
    const pdf = new Blob([enc.encode('%PDF-1.7\n1 0 obj<<>>endobj\n')]);
    expect(await sniffCv(pdf)).toEqual({ ok: false, reason: 'pdf_structure' });
  });

  it('decides by bytes, never by the browser type: a "PDF" that is HTML is refused', async () => {
    const fake = new Blob([enc.encode('<html><script>x</script></html>')], {
      type: 'application/pdf',
    });
    expect(await sniffCv(fake)).toEqual({ ok: false, reason: 'unknown_type' });
  });

  it('refuses an empty file', async () => {
    expect(await sniffCv(new Blob([]))).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('sniffCv — .docx', () => {
  it('accepts a minimal .docx', async () => {
    expect(await sniffCv(await docx())).toEqual({ ok: true, kind: 'docx' });
  });

  it('accepts one with a hyperlink to the web (the one external relationship allowed)', async () => {
    const rels = DOC_RELS(
      '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://behance.net/me" TargetMode="External"/>',
    );
    expect(await sniffCv(await docx([], { rels }))).toEqual({ ok: true, kind: 'docx' });
  });

  it('accepts one with a ZIP comment after the central directory', async () => {
    const withComment = await zip(
      [
        { name: '[Content_Types].xml', text: CONTENT_TYPES },
        { name: 'word/document.xml', text: '<w:document/>' },
      ],
      { comment: 'made by an exporter' },
    );
    expect(await sniffCv(withComment)).toEqual({ ok: true, kind: 'docx' });
  });

  it('refuses a ZIP that is not a Word document (an .xlsx, a plain archive)', async () => {
    const plain = await zip([{ name: 'readme.txt', text: 'hi' }]);
    expect(await sniffCv(plain)).toEqual({ ok: false, reason: 'not_docx' });
  });

  it('refuses macros: vbaProject.bin', async () => {
    const f = await docx([{ name: 'word/vbaProject.bin', text: 'x' }]);
    expect(await sniffCv(f)).toEqual({ ok: false, reason: 'macro' });
  });

  it('refuses a macro-enabled main part declared in the content types', async () => {
    const types = CONTENT_TYPES.replace(
      'document.main+xml',
      'document.macroEnabled.main+xml',
    ).replace(
      'officedocument.wordprocessingml.document.macroEnabled',
      'ms-word.document.macroEnabled',
    );
    expect(await sniffCv(await docx([], { types }))).toEqual({ ok: false, reason: 'macro' });
  });

  it('refuses ActiveX controls and embedded objects', async () => {
    expect(await sniffCv(await docx([{ name: 'word/activeX/activeX1.xml', text: 'x' }]))).toEqual({
      ok: false,
      reason: 'active_content',
    });
    expect(
      await sniffCv(await docx([{ name: 'word/embeddings/oleObject1.bin', text: 'x' }])),
    ).toEqual({ ok: false, reason: 'active_content' });
  });

  it('refuses a remote template (an external relationship that is not a hyperlink)', async () => {
    const rels = DOC_RELS(
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://evil.example/t.dotm" TargetMode="External"/>',
    );
    const f = await zip([
      { name: '[Content_Types].xml', text: CONTENT_TYPES, deflate: true },
      { name: 'word/document.xml', text: '<w:document/>' },
      { name: 'word/_rels/settings.xml.rels', text: rels, deflate: true },
    ]);
    expect(await sniffCv(f)).toEqual({ ok: false, reason: 'external_relationship' });
  });

  it('refuses an encrypted entry', async () => {
    const f = await docx([{ name: 'word/secret.xml', text: 'x', flags: 1 }]);
    expect(await sniffCv(f)).toEqual({ ok: false, reason: 'encrypted' });
  });

  it('refuses a ZIP whose end record is missing (truncated upload)', async () => {
    const full = new Uint8Array(await (await docx()).arrayBuffer());
    const cut = new Blob([full.slice(0, full.length - 30)]);
    expect(await sniffCv(cut)).toEqual({ ok: false, reason: 'zip_structure' });
  });
});

describe('hasExternalRelationship', () => {
  it('ignores internal relationships and hyperlinks; flags anything else external', () => {
    expect(hasExternalRelationship('<Relationship Type="x/styles" Target="styles.xml"/>')).toBe(
      false,
    );
    expect(
      hasExternalRelationship(
        `<Relationship Type='http://x/relationships/hyperlink' TargetMode='External' Target='https://a'/>`,
      ),
    ).toBe(false);
    expect(
      hasExternalRelationship(
        '<Relationship Type="http://x/relationships/oleObject" TargetMode="External" Target="file://a"/>',
      ),
    ).toBe(true);
  });
});
