import { describe, it, expect } from 'vitest';
import {
  sniffCv,
  decodeEntities,
  decodeXmlPart,
  isLocalTemplatePath,
  xmlElements,
} from '@/lib/applications/fileSniff';

// Real bytes, not mocks: a minimal ZIP writer (stored or deflated entries; CRCs are not
// checked by the sniff, so they are zero) builds each .docx case, and the PDFs are their
// smallest valid shape. Every refusal reason the endpoint maps to `bad_type` is here, and
// so are the ordinary documents that must keep passing (a hyperlink, a template-based CV,
// a native chart).

const enc = new TextEncoder();

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface Part {
  name: string;
  text?: string;
  bytes?: Uint8Array;
  deflate?: boolean;
  flags?: number;
  /** Write this name into the LOCAL header instead (a directory/local disagreement). */
  localName?: string;
  /** Write these sizes into the local header instead. */
  localSizes?: [number, number];
}

interface ZipOptions {
  comment?: string;
  prefix?: Uint8Array;
  suffix?: Uint8Array;
  /** Point this entry's directory record at another entry's data (shared offsets). */
  shareOffsetWith?: [number, number];
}

async function zip(parts: Part[], opts: ZipOptions = {}): Promise<Blob> {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const prefix = opts.prefix ?? new Uint8Array();
  const offsets: number[] = [];
  let offset = prefix.length;
  for (const part of parts) {
    const name = enc.encode(part.name);
    const localName = enc.encode(part.localName ?? part.name);
    const raw = part.bytes ?? enc.encode(part.text ?? '');
    const data = part.deflate ? await deflateRaw(raw) : raw;
    const method = part.deflate ? 8 : 0;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, part.flags ?? 0, true);
    lh.setUint16(8, method, true);
    lh.setUint32(18, part.localSizes?.[0] ?? data.length, true);
    lh.setUint32(22, part.localSizes?.[1] ?? raw.length, true);
    lh.setUint16(26, localName.length, true);
    locals.push(new Uint8Array(lh.buffer), localName, data);
    offsets.push(offset);
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
    offset += 30 + localName.length + data.length;
  }
  if (opts.shareOffsetWith) {
    const [from, to] = opts.shareOffsetWith;
    new DataView(central[from * 2]!.buffer).setUint32(42, offsets[to]!, true);
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
  return new Blob([
    prefix,
    ...locals,
    ...central,
    new Uint8Array(eocd.buffer),
    comment,
    opts.suffix ?? new Uint8Array(),
  ] as BlobPart[]);
}

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const TYPES = (extra = '') =>
  `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="${MAIN}"/>${extra}</Types>`;
const RELS = (rels: string) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
const ROOT_RELS = RELS(
  `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>`,
);
const DOC_RELS = RELS(`<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>`);

const docx = (
  extra: Part[] = [],
  over: Partial<Record<'types' | 'root' | 'doc', string>> = {},
  opts: ZipOptions = {},
) =>
  zip(
    [
      { name: '[Content_Types].xml', text: over.types ?? TYPES(), deflate: true },
      { name: '_rels/.rels', text: over.root ?? ROOT_RELS, deflate: true },
      { name: 'word/document.xml', text: '<w:document/>', deflate: true },
      { name: 'word/_rels/document.xml.rels', text: over.doc ?? DOC_RELS, deflate: true },
      ...extra,
    ],
    opts,
  );

const ok = { ok: true, kind: 'docx' };
const refused = (reason: string) => ({ ok: false, reason });

describe('sniffCv — PDF', () => {
  it('accepts a PDF: %PDF- at the start, %%EOF at the end', async () => {
    const pdf = new Blob([enc.encode('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')]);
    expect(await sniffCv(pdf)).toEqual({ ok: true, kind: 'pdf' });
  });

  it('refuses a truncated PDF (no %%EOF in the tail)', async () => {
    const pdf = new Blob([enc.encode('%PDF-1.7\n1 0 obj<<>>endobj\n')]);
    expect(await sniffCv(pdf)).toEqual(refused('pdf_structure'));
  });

  it('decides by bytes, never by the browser type: a "PDF" that is HTML is refused', async () => {
    const fake = new Blob([enc.encode('<html><script>x</script></html>')], {
      type: 'application/pdf',
    });
    expect(await sniffCv(fake)).toEqual(refused('unknown_type'));
  });

  it('refuses an empty file', async () => {
    expect(await sniffCv(new Blob([]))).toEqual(refused('empty'));
  });
});

describe('sniffCv — ordinary Word documents pass', () => {
  it('a minimal .docx', async () => {
    expect(await sniffCv(await docx())).toEqual(ok);
  });

  it('a hyperlink to the web (the external relationship a CV needs)', async () => {
    const doc = RELS(
      `<Relationship Id="rId9" Type="${R}/hyperlink" Target="https://behance.net/me?a=1&amp;b=2" TargetMode="External"/>`,
    );
    expect(await sniffCv(await docx([], { doc }))).toEqual(ok);
  });

  it('a CV made from a downloaded template (Word links the template on the author’s disk)', async () => {
    for (const target of [
      'file:///C:\\Users\\noura\\AppData\\Roaming\\Microsoft\\Templates\\Resume.dotx',
      'file:///Users/noura/Library/Group%20Containers/UBF8T346G9.Office/Templates/CV.dotx',
    ]) {
      const settings = {
        name: 'word/_rels/settings.xml.rels',
        text: RELS(
          `<Relationship Id="rId1" Type="${R}/attachedTemplate" Target="${target}" TargetMode="External"/>`,
        ),
        deflate: true,
      };
      expect(await sniffCv(await docx([settings])), target).toEqual(ok);
    }
  });

  it('a native chart, with the workbook Word embeds for its data', async () => {
    const types = TYPES(
      `<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>` +
        `<Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
    );
    const f = await docx(
      [
        { name: 'word/charts/chart1.xml', text: '<c:chartSpace/>', deflate: true },
        {
          name: 'word/charts/_rels/chart1.xml.rels',
          text: RELS(
            `<Relationship Id="rId1" Type="${R}/package" Target="../embeddings/Microsoft_Excel_Worksheet.xlsx"/>`,
          ),
          deflate: true,
        },
        { name: 'word/embeddings/Microsoft_Excel_Worksheet.xlsx', text: 'PK…' },
      ],
      { types },
    );
    expect(await sniffCv(f)).toEqual(ok);
  });

  it('a ZIP comment after the central directory', async () => {
    expect(await sniffCv(await docx([], {}, { comment: 'made by an exporter' }))).toEqual(ok);
  });
});

describe('sniffCv — macros and active content, wherever they are', () => {
  it('a VBA project, by name, by content type at any path, and by relationship', async () => {
    expect(await sniffCv(await docx([{ name: 'word/vbaProject.bin', text: 'x' }]))).toEqual(
      refused('macro'),
    );
    const types = TYPES(
      `<Override PartName="/media/a.dat" ContentType="application/vnd.ms-office.vbaProject"/>`,
    );
    expect(await sniffCv(await docx([{ name: 'media/a.dat', text: 'x' }], { types }))).toEqual(
      refused('macro'),
    );
    const doc = RELS(
      `<Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="x.bin"/>`,
    );
    expect(await sniffCv(await docx([], { doc }))).toEqual(refused('macro'));
  });

  it('a macro-enabled main part', async () => {
    const types = TYPES().replace(MAIN, 'application/vnd.ms-word.document.macroEnabled.main+xml');
    expect(await sniffCv(await docx([], { types }))).toEqual(refused('macro'));
  });

  it('ActiveX and OLE objects, by path, by content type and by relationship', async () => {
    expect(await sniffCv(await docx([{ name: 'word/activeX/activeX1.xml', text: 'x' }]))).toEqual(
      refused('active_content'),
    );
    const types = TYPES(
      `<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>`,
    );
    expect(await sniffCv(await docx([{ name: 'stuff/object.bin', text: 'x' }], { types }))).toEqual(
      refused('active_content'),
    );
    const doc = RELS(`<Relationship Id="rId1" Type="${R}/oleObject" Target="embeddings/o.bin"/>`);
    expect(await sniffCv(await docx([], { doc }))).toEqual(refused('active_content'));
  });

  it('an embedded document that is not a chart’s workbook, an altChunk, a subdocument', async () => {
    for (const rel of [
      `<Relationship Id="rId1" Type="${R}/package" Target="embeddings/doc.docx"/>`,
      `<Relationship Id="rId1" Type="${R}/aFChunk" Target="afchunk.mht"/>`,
      `<Relationship Id="rId1" Type="${R}/subDocument" Target="sub.docx"/>`,
    ]) {
      expect(await sniffCv(await docx([], { doc: RELS(rel) })), rel).toEqual(
        refused('active_content'),
      );
    }
  });

  it('a relationship file outside word/_rels/ is checked too', async () => {
    const hidden = {
      name: 'custom/_rels/part.xml.rels',
      text: RELS(`<Relationship Id="rId1" Type="${R}/oleObject" Target="o.bin"/>`),
      deflate: true,
    };
    expect(await sniffCv(await docx([hidden]))).toEqual(refused('active_content'));
  });
});

describe('sniffCv — links out of the file', () => {
  const settings = (target: string, mode = ' TargetMode="External"') => ({
    name: 'word/_rels/settings.xml.rels',
    text: RELS(`<Relationship Id="rId1" Type="${R}/attachedTemplate" Target="${target}"${mode}/>`),
    deflate: true,
  });

  it('a remote template: a web address or a network share', async () => {
    for (const target of [
      'https://evil.example/t.dotm',
      '\\\\attacker\\share\\t.dotm',
      'file://attacker/share/t.dotm',
      'file:////attacker/share/t.dotm',
      'file:///%5C%5Cattacker/share/t.dotm',
    ]) {
      expect(await sniffCv(await docx([settings(target)])), target).toEqual(
        refused('external_relationship'),
      );
    }
  });

  it('a template relationship Word would never write (internal)', async () => {
    expect(await sniffCv(await docx([settings('template.dotm', '')]))).toEqual(
      refused('external_relationship'),
    );
  });

  it('any other external target: a linked image, a mail-merge data source', async () => {
    const image = RELS(
      `<Relationship Id="rId1" Type="${R}/image" Target="\\\\attacker\\x.png" TargetMode="External"/>`,
    );
    expect(await sniffCv(await docx([], { doc: image }))).toEqual(refused('external_relationship'));
    const merge = RELS(`<Relationship Id="rId1" Type="${R}/mailMergeSource" Target="data.xlsx"/>`);
    expect(await sniffCv(await docx([], { doc: merge }))).toEqual(refused('external_relationship'));
  });

  it('cannot be hidden by spelling: references, prefixes, a > in a value, look-alike names', async () => {
    for (const rel of [
      // TargetMode written as character references.
      `<Relationship Id="rId1" Type="${R}/image" Target="https://e.example/x" TargetMode="&#x45;xternal"/>`,
      // A namespace prefix on the element.
      `<r:Relationship xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships" Id="rId1" Type="${R}/image" Target="https://e.example/x" TargetMode="External"/>`,
      // A '>' inside a quoted value must not end the tag before TargetMode.
      `<Relationship Id="rId1" Type="${R}/image" Target="https://e.example/a>b" TargetMode="External"/>`,
      // An attribute whose name ENDS in "Type" must not supply the type.
      `<Relationship Id="rId1" xType="${R}/hyperlink" Type="${R}/image" Target="https://e.example/x" TargetMode="External"/>`,
    ]) {
      expect(await sniffCv(await docx([], { doc: RELS(rel) })), rel).toEqual(
        refused('external_relationship'),
      );
    }
  });

  it('cannot be hidden by encoding: UTF-16, NUL bytes, a DOCTYPE', async () => {
    const utf16 = (s: string) => {
      const b = new Uint8Array(2 + s.length * 2);
      b[0] = 0xff;
      b[1] = 0xfe;
      for (let i = 0; i < s.length; i += 1) b[2 + i * 2] = s.charCodeAt(i);
      return b;
    };
    const ext = RELS(
      `<Relationship Id="rId1" Type="${R}/image" Target="https://e.example/x" TargetMode="External"/>`,
    );
    const f16 = await docx([
      { name: 'word/_rels/settings.xml.rels', bytes: utf16(ext), deflate: true },
    ]);
    expect(await sniffCv(f16)).toEqual(refused('xml_structure'));
    const dtd = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY e "External">]>${DOC_RELS}`;
    expect(await sniffCv(await docx([], { doc: dtd }))).toEqual(refused('xml_structure'));
  });
});

describe('sniffCv — the main document is the one the package names', () => {
  it('no package relationships at all → not a Word document', async () => {
    const f = await zip([
      { name: '[Content_Types].xml', text: TYPES() },
      { name: 'word/document.xml', text: '<w:document/>' },
    ]);
    expect(await sniffCv(f)).toEqual(refused('not_docx'));
  });

  it('a package whose main part is elsewhere, or that names two', async () => {
    const elsewhere = RELS(
      `<Relationship Id="rId1" Type="${R}/officeDocument" Target="other/main.xml"/>`,
    );
    expect(await sniffCv(await docx([], { root: elsewhere }))).toEqual(refused('not_docx'));
    const two = RELS(
      `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>` +
        `<Relationship Id="rId2" Type="${R}/officeDocument" Target="word/document.xml"/>`,
    );
    expect(await sniffCv(await docx([], { root: two }))).toEqual(refused('not_docx'));
  });

  it('a main part that is not a plain Word document (a template, an unknown type)', async () => {
    const template = TYPES().replace(
      MAIN,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
    );
    expect(await sniffCv(await docx([], { types: template }))).toEqual(refused('not_docx'));
  });

  it('a ZIP that is not a Word document (an .xlsx, a plain archive)', async () => {
    expect(await sniffCv(await zip([{ name: 'readme.txt', text: 'hi' }]))).toEqual(
      refused('not_docx'),
    );
  });
});

describe('sniffCv — one archive, one reading', () => {
  it('refuses bytes before or after the archive (a polyglot)', async () => {
    expect(await sniffCv(await docx([], {}, { suffix: enc.encode('trailing') }))).toEqual(
      refused('zip_structure'),
    );
    // A prefix shifts every offset; the directory then no longer ends at its end record.
    const f = await docx([], {}, { prefix: enc.encode('PK\x03\x04junk') });
    expect((await sniffCv(f)).ok).toBe(false);
  });

  it('refuses two entries with one name (in any case), or one data block shared', async () => {
    const dup = await docx([{ name: 'WORD/document.xml', text: 'x' }]);
    expect(await sniffCv(dup)).toEqual(refused('zip_structure'));
    const shared = await docx([{ name: 'word/x.xml', text: 'x' }], {}, { shareOffsetWith: [4, 2] });
    expect(await sniffCv(shared)).toEqual(refused('zip_structure'));
  });

  it('refuses a local header that disagrees with the directory (name or sizes)', async () => {
    const renamed = await zip([
      { name: '[Content_Types].xml', text: TYPES() },
      { name: '_rels/.rels', text: ROOT_RELS, localName: '_rels/.relz' },
      { name: 'word/document.xml', text: '<w:document/>' },
    ]);
    expect(await sniffCv(renamed)).toEqual(refused('zip_structure'));
    const resized = await zip([
      { name: '[Content_Types].xml', text: TYPES() },
      { name: '_rels/.rels', text: ROOT_RELS, localSizes: [9999, 9999] },
      { name: 'word/document.xml', text: '<w:document/>' },
    ]);
    expect(await sniffCv(resized)).toEqual(refused('zip_structure'));
  });

  it('refuses path tricks in entry names', async () => {
    for (const name of ['../evil.xml', '/word/x.xml', 'word\\x.xml']) {
      expect(await sniffCv(await docx([{ name, text: 'x' }])), name).toEqual(
        refused('zip_structure'),
      );
    }
  });

  it('refuses an encrypted entry and a truncated archive', async () => {
    expect(await sniffCv(await docx([{ name: 'word/secret.xml', text: 'x', flags: 1 }]))).toEqual(
      refused('encrypted'),
    );
    const full = new Uint8Array(await (await docx()).arrayBuffer());
    expect(await sniffCv(new Blob([full.slice(0, full.length - 30)]))).toEqual(
      refused('zip_structure'),
    );
  });

  it('bounds its own work: too many relationship files, too much to inflate', async () => {
    const many = Array.from({ length: 65 }, (_, i) => ({
      name: `p${i}/_rels/x.xml.rels`,
      text: DOC_RELS,
    }));
    expect(await sniffCv(await docx(many))).toEqual(refused('too_complex'));
    // Each part under its own cap, together over the total.
    const padding = ' '.repeat(500 * 1024);
    const heavy = Array.from({ length: 5 }, (_, i) => ({
      name: `heavy${i}/_rels/x.xml.rels`,
      text: RELS(padding),
      deflate: true,
    }));
    expect(await sniffCv(await docx(heavy))).toEqual(refused('too_complex'));
  });
});

describe('the XML helpers', () => {
  it('reads unprefixed attributes by the grammar, decoding references', () => {
    expect(
      xmlElements(
        `<a:Relationship x:Type="no" Type='t&#x2F;hyperlink' Target="a>b" TargetMode="&amp;"/>`,
        'Relationship',
      ),
    ).toEqual([{ Type: 't/hyperlink', Target: 'a>b', TargetMode: '&' }]);
    expect(xmlElements('<RelationshipX Type="x"/>', 'Relationship')).toEqual([]);
    expect(xmlElements('<Relationship Type="a" Type="b"/>', 'Relationship')).toBeNull();
    expect(xmlElements('<Relationship Type=unquoted/>', 'Relationship')).toBeNull();
  });

  it('decodes character and named references', () => {
    expect(decodeEntities('&#69;xternal &#x45; &lt;&gt;&quot;&apos;&amp;')).toBe(
      'External E <>"\'&',
    );
    expect(decodeEntities('&unknown;')).toBe('&unknown;');
  });

  it('refuses part text it cannot read as Word does', () => {
    expect(decodeXmlPart(new Uint8Array([0xff, 0xfe, 0x3c, 0x00]))).toBeNull();
    expect(decodeXmlPart(enc.encode('<a>\0</a>'))).toBeNull();
    expect(decodeXmlPart(enc.encode('<a/>'))).toBe('<a/>');
  });

  it('tells a template on the author’s disk from one on someone else’s machine', () => {
    expect(isLocalTemplatePath('file:///C:/Users/me/Templates/CV.dotx')).toBe(true);
    expect(isLocalTemplatePath('C:\\Users\\me\\CV.dotx')).toBe(true);
    expect(isLocalTemplatePath('file:///home/me/cv.dotx')).toBe(true);
    expect(isLocalTemplatePath('https://e.example/t.dotm')).toBe(false);
    expect(isLocalTemplatePath('\\\\host\\share\\t.dotm')).toBe(false);
    expect(isLocalTemplatePath('file://host/share/t.dotm')).toBe(false);
    expect(isLocalTemplatePath('file:///%5C%5Chost/t.dotm')).toBe(false);
    expect(isLocalTemplatePath('file:///%E0%A4%A')).toBe(false);
  });
});
