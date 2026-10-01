import type { CvKind } from '@schemas/application';

// What a CV must be before it is stored: a PDF, or a Word .docx with no macros, no ActiveX,
// no embedded objects and no links that reach outside the file (owner decision J2).
//
// Built for the Workers FREE plan (10 ms CPU per request): it reads only the HEAD and the
// TAIL of the file, plus the package's small XML parts — its content types and its
// relationship files — located through the ZIP central directory, so its CPU cost does not
// grow with the file. `Blob.slice()` is a view, and the inflate is the runtime's native
// DecompressionStream, capped per part and in total.
//
// A .docx is checked the way Word reads one, not the way Word usually writes one: a part
// can live at any path, so what decides is each part's declared CONTENT TYPE and every
// RELATIONSHIP in every `_rels/*.rels` of the package, and the main document is the one
// the package's own `_rels/.rels` names. The ZIP itself must be unambiguous (nothing before
// or after the archive, no duplicate names or shared data, local headers that agree with
// the directory), so another reader cannot see a different file in the same bytes.
//
// What it deliberately does NOT do:
//   • scan a whole PDF for `/JavaScript`, `/Launch`, `/OpenAction`. Modern PDFs keep those
//     inside compressed object streams, so a byte scan misses them — a check that costs a
//     full pass over 10 MB and still cannot see the thing it looks for is not a control.
//   • read the body of a .docx (`word/document.xml`) — so field codes in the text (DDE,
//     INCLUDEPICTURE) are not checked: Word splits them across runs, a scan would be cheap
//     to evade, and Word asks before it updates them.
//   • accept legacy `.doc` (OLE). Macros live inside its compound file; telling a clean one
//     from a macro one means parsing the whole container.
//   • trust the browser's MIME type or the file name. The kind is decided here.
// The controls for what it cannot see do not depend on reading the file: the admin
// downloads it as an attachment under a sandbox CSP, and the panel says it has not been
// virus-scanned (EXC-008).

export type SniffRefusal =
  | 'empty'
  | 'unknown_type'
  | 'pdf_structure'
  | 'zip_structure'
  | 'zip64'
  | 'encrypted'
  | 'too_complex'
  | 'xml_structure'
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
const MAX_ENTRIES = 1000;
/** The parts this reads (content types, relationship files) are small XML. */
const MAX_PART_BYTES = 512 * 1024;
/** A Word document has a handful of relationship files; a CV never needs this many. */
const MAX_RELS_PARTS = 64;
/** Everything this inflates, together — the bound on its CPU, whatever the archive says. */
const MAX_TOTAL_INFLATED = 2 * 1024 * 1024;

const MAIN_DOCUMENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
/** A native Word chart keeps its data in an embedded workbook — the one embedding allowed. */
const CHART_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
  'application/vnd.ms-office.chartex+xml',
]);
const WORKBOOK_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Relationship types (the last segment of the type URI, lower-cased) refused anywhere. */
const MACRO_RELATIONSHIPS = new Set([
  'vbaproject',
  'vbaprojectsignature',
  'wordvbadata',
  'keymapcustomizations',
]);
const ACTIVE_RELATIONSHIPS = new Set([
  'oleobject',
  'control',
  'activexcontrolbinary',
  'afchunk',
  'subdocument',
  'frame',
  'extensibility',
]);
const DATA_SOURCE_RELATIONSHIPS = new Set([
  'mailmergesource',
  'mailmergeheadersource',
  'recipientdata',
]);

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

/** Bytes as Latin-1 text, without a decoder the runtime may not ship. */
function latin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
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
  const tail = latin1(await read(file, Math.max(0, file.size - 1024), file.size));
  return tail.includes('%%EOF')
    ? { ok: true, kind: 'pdf' }
    : { ok: false, reason: 'pdf_structure' };
}

// ── The ZIP ─────────────────────────────────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  nameBytes: Uint8Array;
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
  // The comment must end exactly where the file does: nothing is appended after the archive.
  if (eocd + 22 + u16(tail, eocd + 20) !== tail.length) return 'zip_structure';
  const disk = u16(tail, eocd + 4);
  const cdDisk = u16(tail, eocd + 6);
  const onDisk = u16(tail, eocd + 8);
  const total = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdOffset = u32(tail, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return 'zip64';
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) return 'zip_structure';
  if (total > MAX_ENTRIES || cdSize > MAX_CENTRAL_DIRECTORY) return 'too_complex';
  // The directory ends where its end record starts: no gap a second reader could fill.
  if (cdOffset + cdSize !== tailStart + eocd) return 'zip_structure';

  const cd = await read(file, cdOffset, cdOffset + cdSize);
  const entries: ZipEntry[] = [];
  const seenNames = new Set<string>();
  const seenOffsets = new Set<number>();
  let p = 0;
  for (let n = 0; n < total; n += 1) {
    if (p + 46 > cd.length || u32(cd, p) !== ZIP_CENTRAL) return 'zip_structure';
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) return 'zip_structure';
    const nameBytes = cd.slice(p + 46, p + 46 + nameLen);
    const name = utf8.decode(nameBytes);
    const entry: ZipEntry = {
      name,
      nameBytes,
      flags: u16(cd, p + 8),
      method: u16(cd, p + 10),
      compressedSize: u32(cd, p + 20),
      size: u32(cd, p + 24),
      localOffset: u32(cd, p + 42),
    };
    // A name two readers could resolve differently, or a second entry for the same name or
    // the same data, is how one archive shows different files to different readers.
    if (
      name.length === 0 ||
      name.includes('\uFFFD') ||
      name.includes('\0') ||
      name.includes('\\') ||
      name.startsWith('/') ||
      name.split('/').includes('..')
    ) {
      return 'zip_structure';
    }
    const key = name.toLowerCase();
    if (seenNames.has(key) || seenOffsets.has(entry.localOffset)) return 'zip_structure';
    seenNames.add(key);
    seenOffsets.add(entry.localOffset);
    if (entry.localOffset + 30 + nameLen > cdOffset) return 'zip_structure';
    if (!name.endsWith('/') && entry.method !== 0 && entry.method !== 8) return 'zip_structure';
    entries.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== cd.length) return 'zip_structure';
  // The archive starts at byte 0: nothing is prepended before the first local header.
  if (entries.length > 0 && Math.min(...entries.map((e) => e.localOffset)) !== 0) {
    return 'zip_structure';
  }
  return entries;
}

/** Inflates at most `cap` bytes; null when the data is larger or not deflate. */
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

/** Reads parts while keeping the total inflated budget for the whole check. */
class PartReader {
  private spent = 0;
  constructor(private readonly file: Blob) {}

  /**
   * Where `entry`'s data starts, once its local header agrees with the directory — the same
   * name, method, encryption bit and sizes, so a reader that trusts the local header sees
   * the bytes this check read. Null when they disagree.
   */
  async localAgrees(entry: ZipEntry): Promise<number | null> {
    const local = await read(this.file, entry.localOffset, entry.localOffset + 30);
    if (u32(local, 0) !== ZIP_LOCAL) return null;
    if (u16(local, 8) !== entry.method || (u16(local, 6) & 0x1) !== (entry.flags & 0x1)) {
      return null;
    }
    // With a data descriptor (bit 3) the local sizes may be zero; otherwise they must match.
    const lc = u32(local, 18);
    const lu = u32(local, 22);
    const described = (entry.flags & 0x8) !== 0;
    const sizesAgree = lc === entry.compressedSize && lu === entry.size;
    if (!sizesAgree && !(described && lc === 0 && lu === 0)) return null;
    const nameLen = u16(local, 26);
    const extraLen = u16(local, 28);
    if (nameLen !== entry.nameBytes.length) return null;
    const name = await read(this.file, entry.localOffset + 30, entry.localOffset + 30 + nameLen);
    for (let i = 0; i < nameLen; i += 1) if (name[i] !== entry.nameBytes[i]) return null;
    return entry.localOffset + 30 + nameLen + extraLen;
  }

  /** One part's bytes; a refusal when it is too big, unreadable or over the total budget. */
  async bytes(entry: ZipEntry): Promise<Uint8Array | SniffRefusal> {
    if (entry.size > MAX_PART_BYTES || entry.compressedSize > MAX_PART_BYTES) return 'too_complex';
    const start = await this.localAgrees(entry);
    if (start === null) return 'zip_structure';
    const remaining = MAX_TOTAL_INFLATED - this.spent;
    if (remaining <= 0) return 'too_complex';
    const data = await read(this.file, start, start + entry.compressedSize);
    let out: Uint8Array | null;
    if (entry.method === 0) {
      out = data.length > remaining ? null : data;
    } else {
      try {
        out = await inflateRaw(data, Math.min(MAX_PART_BYTES, remaining));
      } catch {
        return 'zip_structure';
      }
    }
    if (out === null) return 'too_complex';
    if (out.length !== entry.size) return 'zip_structure';
    this.spent += out.length;
    return out;
  }

  /** One XML part's text, or why it cannot be read. */
  async xml(entry: ZipEntry | undefined): Promise<{ text: string } | { refusal: SniffRefusal }> {
    if (!entry) return { refusal: 'not_docx' };
    const bytes = await this.bytes(entry);
    if (typeof bytes === 'string') return { refusal: bytes };
    const text = decodeXmlPart(bytes);
    return text === null ? { refusal: 'xml_structure' } : { text };
  }
}

// ── The package's XML ───────────────────────────────────────────────────────────────────

/**
 * A package XML part as text. Word writes these as UTF-8; anything else — a UTF-16 byte
 * order mark, NUL bytes, a DOCTYPE (where entity tricks live) — is refused rather than
 * decoded, since this check must read exactly what Word would.
 */
export function decodeXmlPart(bytes: Uint8Array): string | null {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    return null;
  }
  if (bytes.includes(0)) return null;
  const text = utf8.decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return null;
  return text;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** An attribute value as XML means it: `&#x45;xternal` is `External`. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    const r = ref.toLowerCase();
    if (r.startsWith('#')) {
      const cp = r[1] === 'x' ? Number.parseInt(r.slice(2), 16) : Number.parseInt(r.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return NAMED_ENTITIES[r] ?? whole;
  });
}

/**
 * Every `<name …>` element (any namespace prefix), as its UNPREFIXED attributes — the ones
 * OPC defines (a prefixed attribute belongs to another namespace; Word ignores it). Parsed
 * with the attribute grammar, so a `>` inside a quoted value cannot end the tag early and
 * hide the attributes after it. Null when an element is malformed or repeats an attribute.
 */
export function xmlElements(xml: string, name: string): Record<string, string>[] | null {
  const out: Record<string, string>[] = [];
  const open = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${name}(?=[\\s/>])`, 'g');
  const attr = /\s*([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  const close = /\s*\/?>/y;
  for (const m of xml.matchAll(open)) {
    let p = (m.index ?? 0) + m[0].length;
    const attrs: Record<string, string> = {};
    for (;;) {
      close.lastIndex = p;
      if (close.test(xml)) break;
      attr.lastIndex = p;
      const a = attr.exec(xml);
      if (!a) return null;
      const key = a[1] ?? '';
      if (!key.includes(':')) {
        if (Object.hasOwn(attrs, key)) return null;
        attrs[key] = decodeEntities(a[2] ?? a[3] ?? '');
      }
      p = attr.lastIndex;
    }
    out.push(attrs);
  }
  return out;
}

/** OPC part names are case-insensitive; ZIP names carry no leading slash. */
const partKey = (name: string) => name.replace(/^\/+/, '').toLowerCase();

/** `dir/_rels/name.rels` → `dir/name`; `_rels/.rels` → the package itself (''). */
function sourceOfRels(relsName: string): string {
  const m = /^(.*?)_rels\/([^/]*)\.rels$/i.exec(relsName);
  return m ? `${m[1] ?? ''}${m[2] ?? ''}` : '';
}

/** A relationship target resolved against its source part, as a ZIP-style part key. */
function resolveTarget(source: string, target: string): string {
  const base = target.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') base.pop();
    else base.push(seg);
  }
  return partKey(base.join('/'));
}

/** The last segment of a relationship type URI, lower-cased (`…/oleObject` → `oleobject`). */
function relationshipKind(type: string): string {
  return (type.replace(/\/+$/, '').split('/').pop() ?? '').toLowerCase();
}

/**
 * Is an external template target a path on the author's own machine? Word adds one to every
 * document made from a downloaded template (`file:///C:/Users/…/Templates/x.dotx`); the
 * attack is a template on someone else's machine — a web address or a network share.
 */
export function isLocalTemplatePath(target: string): boolean {
  let t = target.trim();
  try {
    t = decodeURIComponent(t);
  } catch {
    return false;
  }
  t = t.replace(/\\/g, '/');
  return /^file:\/\/\/[^/]/i.test(t) || /^[a-z]:\/[^/]/i.test(t);
}

interface ContentTypes {
  defaults: Map<string, string>;
  overrides: Map<string, string>;
}

function contentTypeOf(types: ContentTypes, name: string): string {
  const key = partKey(name);
  const override = types.overrides.get(key);
  if (override !== undefined) return override;
  const last = key.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot < 0 ? '' : (types.defaults.get(last.slice(dot + 1)) ?? '');
}

function contentTypeRefusal(type: string): SniffRefusal | null {
  const t = type.toLowerCase();
  if (/macroenabled|vbaproject|vbadata|keymapcustomizations/.test(t)) return 'macro';
  if (/activex|oleobject/.test(t)) return 'active_content';
  return null;
}

/** Why one relationship refuses the file, or null when it is allowed. */
function relationshipRefusal(
  rel: Record<string, string>,
  source: string,
  types: ContentTypes,
): SniffRefusal | null {
  const kind = relationshipKind(rel['Type'] ?? '');
  const target = rel['Target'] ?? '';
  const external = (rel['TargetMode'] ?? '').trim().toLowerCase() === 'external';
  if (MACRO_RELATIONSHIPS.has(kind)) return 'macro';
  if (ACTIVE_RELATIONSHIPS.has(kind)) return 'active_content';
  if (DATA_SOURCE_RELATIONSHIPS.has(kind)) return 'external_relationship';
  // A template is allowed only as Word writes one: external, and on the author's machine.
  if (kind === 'attachedtemplate') {
    return external && isLocalTemplatePath(target) ? null : 'external_relationship';
  }
  if (external) return kind === 'hyperlink' ? null : 'external_relationship';
  if (kind === 'package') {
    // An embedded package is allowed only as a chart's own workbook.
    const sourceType = contentTypeOf(types, source);
    const targetType = contentTypeOf(types, resolveTarget(source, target));
    if (!CHART_TYPES.has(sourceType) || targetType !== WORKBOOK_TYPE) return 'active_content';
  }
  return null;
}

async function sniffDocx(file: Blob): Promise<SniffResult> {
  const cd = await centralDirectory(file);
  if (typeof cd === 'string') return { ok: false, reason: cd };
  const byKey = new Map(cd.map((e) => [partKey(e.name), e]));

  for (const e of cd) {
    if ((e.flags & 0x1) !== 0) return { ok: false, reason: 'encrypted' };
    const n = e.name.toLowerCase();
    // Belts under the content-type and relationship rules below.
    if (n.endsWith('vbaproject.bin') || n.endsWith('vbadata.xml')) {
      return { ok: false, reason: 'macro' };
    }
    if (n.split('/').includes('activex')) return { ok: false, reason: 'active_content' };
  }

  const reader = new PartReader(file);

  // The content types: every part is judged by the type Word will give it.
  const typesPart = await reader.xml(byKey.get('[content_types].xml'));
  if ('refusal' in typesPart) return { ok: false, reason: typesPart.refusal };
  const defaults = xmlElements(typesPart.text, 'Default');
  const overrides = xmlElements(typesPart.text, 'Override');
  if (!defaults || !overrides) return { ok: false, reason: 'xml_structure' };
  const types: ContentTypes = {
    defaults: new Map(
      defaults.map((d) => [(d['Extension'] ?? '').toLowerCase(), d['ContentType'] ?? '']),
    ),
    overrides: new Map(
      overrides.map((o) => [partKey(o['PartName'] ?? ''), o['ContentType'] ?? '']),
    ),
  };
  for (const e of cd) {
    if (e.name.endsWith('/') || partKey(e.name) === '[content_types].xml') continue;
    const refusal = contentTypeRefusal(contentTypeOf(types, e.name));
    if (refusal) return { ok: false, reason: refusal };
  }

  // Every relationship file in the package, wherever it lives.
  const relsParts = cd.filter((e) => /(^|\/)_rels\/[^/]*\.rels$/i.test(e.name));
  if (relsParts.length > MAX_RELS_PARTS) return { ok: false, reason: 'too_complex' };
  let mainDocument: string | null = null;
  let mainDocuments = 0;
  for (const e of relsParts) {
    const part = await reader.xml(e);
    if ('refusal' in part) return { ok: false, reason: part.refusal };
    const rels = xmlElements(part.text, 'Relationship');
    if (!rels) return { ok: false, reason: 'xml_structure' };
    const source = sourceOfRels(e.name);
    for (const rel of rels) {
      const refusal = relationshipRefusal(rel, source, types);
      if (refusal) return { ok: false, reason: refusal };
      if (source === '' && relationshipKind(rel['Type'] ?? '') === 'officedocument') {
        mainDocuments += 1;
        mainDocument = resolveTarget('', rel['Target'] ?? '');
      }
    }
  }

  // The main document is the one the package names — and it is a plain Word document.
  if (mainDocuments !== 1 || mainDocument !== 'word/document.xml') {
    return { ok: false, reason: 'not_docx' };
  }
  const main = byKey.get(mainDocument);
  if (!main || contentTypeOf(types, main.name) !== MAIN_DOCUMENT_TYPE) {
    return { ok: false, reason: 'not_docx' };
  }
  if ((await reader.localAgrees(main)) === null) return { ok: false, reason: 'zip_structure' };
  return { ok: true, kind: 'docx' };
}
