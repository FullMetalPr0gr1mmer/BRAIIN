import type { CvKind } from '@schemas/application';

// What a CV must be before it is stored: a PDF, or a Word .docx with no macros, no ActiveX,
// no embedded objects and no external relationships (owner decision J2).
//
// Built for the Workers FREE plan (10 ms CPU per request): it reads only the HEAD and the
// TAIL of the file, plus a handful of tiny parts of a .docx located through the ZIP central
// directory — so its CPU cost does not grow with the file. `Blob.slice()` is a view, and
// the inflate is the runtime's native DecompressionStream.
//
// What it deliberately does NOT do:
//   • scan a whole PDF for `/JavaScript`, `/Launch`, `/OpenAction`. Modern PDFs keep those
//     inside compressed object streams, so a byte scan misses them — a check that costs a
//     full pass over 10 MB and still cannot see the thing it looks for is not a control.
//     The controls for a hostile PDF are the ones that do not depend on reading it: the
//     admin downloads it as an attachment under a sandbox CSP, and the panel says it has
//     not been virus-scanned (EXC-008).
//   • accept legacy `.doc` (OLE). Macros live inside its compound file; telling a clean one
//     from a macro one means parsing the whole container.
//   • trust the browser's MIME type or the file name. The kind is decided here.

export type SniffRefusal =
  | 'empty'
  | 'unknown_type'
  | 'pdf_structure'
  | 'zip_structure'
  | 'zip64'
  | 'encrypted'
  | 'not_docx'
  | 'macro'
  | 'active_content'
  | 'external_relationship';

export type SniffResult = { ok: true; kind: CvKind } | { ok: false; reason: SniffRefusal };

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;

/** A .docx central directory larger than this is not a CV. */
const MAX_CENTRAL_DIRECTORY = 2 * 1024 * 1024;
const MAX_ENTRIES = 4000;
/** The parts this reads (content types, relationship files) are small XML. */
const MAX_PART_BYTES = 512 * 1024;

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');

async function read(file: Blob, start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

const u16 = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, o: number) =>
  ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0;

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((m, i) => bytes[i] === m);
}

export async function sniffCv(file: Blob): Promise<SniffResult> {
  if (file.size === 0) return { ok: false, reason: 'empty' };
  const head = await read(file, 0, 8);
  if (startsWith(head, PDF_MAGIC)) return sniffPdf(file);
  if (u32(head, 0) === ZIP_LOCAL) return sniffDocx(file);
  return { ok: false, reason: 'unknown_type' };
}

/** A PDF starts with `%PDF-` and ends (allowing trailing whitespace/junk) with `%%EOF`. */
async function sniffPdf(file: Blob): Promise<SniffResult> {
  const tail = latin1.decode(await read(file, Math.max(0, file.size - 1024), file.size));
  return tail.includes('%%EOF')
    ? { ok: true, kind: 'pdf' }
    : { ok: false, reason: 'pdf_structure' };
}

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

async function centralDirectory(file: Blob): Promise<ZipEntry[] | SniffRefusal> {
  // End-of-central-directory: 22 bytes, plus a comment of up to 65535.
  const tailStart = Math.max(0, file.size - (22 + 0xffff));
  const tail = await read(file, tailStart, file.size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (u32(tail, i) === ZIP_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return 'zip_structure';
  const disk = u16(tail, eocd + 4);
  const cdDisk = u16(tail, eocd + 6);
  const total = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdOffset = u32(tail, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return 'zip64';
  if (disk !== 0 || cdDisk !== 0) return 'zip_structure';
  if (total > MAX_ENTRIES || cdSize > MAX_CENTRAL_DIRECTORY) return 'zip_structure';
  if (cdOffset + cdSize > file.size) return 'zip_structure';

  const cd = await read(file, cdOffset, cdOffset + cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < total; n += 1) {
    if (p + 46 > cd.length || u32(cd, p) !== ZIP_CENTRAL) return 'zip_structure';
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    if (p + 46 + nameLen > cd.length) return 'zip_structure';
    entries.push({
      flags: u16(cd, p + 8),
      method: u16(cd, p + 10),
      compressedSize: u32(cd, p + 20),
      size: u32(cd, p + 24),
      localOffset: u32(cd, p + 42),
      name: utf8.decode(cd.subarray(p + 46, p + 46 + nameLen)),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array<ArrayBuffer>, cap: number): Promise<Uint8Array | null> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** One small part's text, located by its local header. Null = unreadable. */
async function readPart(file: Blob, entry: ZipEntry): Promise<string | null> {
  if (entry.size > MAX_PART_BYTES || entry.compressedSize > MAX_PART_BYTES) return null;
  const local = await read(file, entry.localOffset, entry.localOffset + 30);
  if (u32(local, 0) !== ZIP_LOCAL) return null;
  const start = entry.localOffset + 30 + u16(local, 26) + u16(local, 28);
  const data = await read(file, start, start + entry.compressedSize);
  if (entry.method === 0) return utf8.decode(data);
  if (entry.method !== 8) return null;
  try {
    const inflated = await inflateRaw(data, MAX_PART_BYTES);
    return inflated ? utf8.decode(inflated) : null;
  } catch {
    return null;
  }
}

/** `<Relationship … TargetMode="External" …>` whose Type is not a plain hyperlink. */
export function hasExternalRelationship(relsXml: string): boolean {
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/TargetMode\s*=\s*["']External["']/i.test(tag)) continue;
    const type = /Type\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    if (!/\/hyperlink$/i.test(type)) return true;
  }
  return false;
}

async function sniffDocx(file: Blob): Promise<SniffResult> {
  const cd = await centralDirectory(file);
  if (typeof cd === 'string') return { ok: false, reason: cd };

  const names = new Set(cd.map((e) => e.name));
  if (!names.has('[Content_Types].xml') || !names.has('word/document.xml')) {
    return { ok: false, reason: 'not_docx' };
  }
  for (const e of cd) {
    if ((e.flags & 0x1) !== 0) return { ok: false, reason: 'encrypted' };
    const n = e.name.toLowerCase();
    if (n.endsWith('vbaproject.bin') || n.endsWith('vbadata.xml')) {
      return { ok: false, reason: 'macro' };
    }
    if (n.startsWith('word/activex/') || n.startsWith('word/embeddings/')) {
      return { ok: false, reason: 'active_content' };
    }
  }

  const types = cd.find((e) => e.name === '[Content_Types].xml');
  const typesXml = types ? await readPart(file, types) : null;
  if (typesXml === null) return { ok: false, reason: 'zip_structure' };
  if (/macroEnabled/i.test(typesXml)) return { ok: false, reason: 'macro' };

  for (const e of cd) {
    if (!/^word\/_rels\/[^/]+\.rels$/i.test(e.name)) continue;
    const rels = await readPart(file, e);
    if (rels === null) return { ok: false, reason: 'zip_structure' };
    if (hasExternalRelationship(rels)) return { ok: false, reason: 'external_relationship' };
  }
  return { ok: true, kind: 'docx' };
}
