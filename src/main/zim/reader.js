'use strict';
/**
 * Minimal Kiwix ZIM reader in pure JavaScript.
 *
 * Written against the ZIM file format spec (openzim.org). We only need the read
 * path: locate an entry, pull its blob out of a cluster, and hand back text.
 *
 * The reason this is hand-rolled rather than a binding to libzim: the whole point
 * of Verity is that it runs offline with nothing to install. Node 22.15+ ships
 * zstd in core, and every Wikipedia ZIM Kiwix has published since 2021 uses zstd
 * clusters, so there is nothing left that needs a native module.
 *
 * What we deliberately do NOT support: the Xapian full-text index. That would
 * need a native Xapian build. Instead we binary-search the title-ordered listing,
 * which is enough to resolve "Ada Lovelace" -> the article, and rank a window of
 * neighbouring titles by token overlap for fuzzier queries.
 */

const fs = require('fs');
const zlib = require('zlib');

const ZIM_MAGIC = 0x044d495a;

// Cluster compression identifiers from the spec.
const COMP_NONE = 0;
const COMP_NONE_OLD = 1;
const COMP_ZLIB = 2;
const COMP_BZIP2 = 3;
const COMP_LZMA = 4;
const COMP_ZSTD = 5;

const MIME_REDIRECT = 0xffff;
const MIME_LINKTARGET = 0xfffe;
const MIME_DELETED = 0xfffd;

/** Read a 64-bit LE offset as a JS number. ZIM offsets are file positions, so
 *  they stay far below 2^53 for any real archive. */
function readU64(buf, off) {
  return Number(buf.readBigUInt64LE(off));
}

class LRU {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  clear() {
    this.map.clear();
  }
}

class ZimReader {
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = null;
    this.header = null;
    this.mimeTypes = [];
    // Decompressed clusters are megabytes each; keep only a handful.
    this.clusterCache = new LRU(6);
    this.direntCache = new LRU(512);
    this._titleOrder = null;
  }

  open() {
    this.fd = fs.openSync(this.filePath, 'r');
    this._readHeader();
    this._readMimeList();
    return this;
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
    this.clusterCache.clear();
    this.direntCache.clear();
    this._titleOrder = null;
  }

  _read(length, position) {
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const n = fs.readSync(this.fd, buf, got, length - got, position + got);
      if (n <= 0) break;
      got += n;
    }
    return got === length ? buf : buf.subarray(0, got);
  }

  _readHeader() {
    const b = this._read(80, 0);
    const magic = b.readUInt32LE(0);
    if (magic !== ZIM_MAGIC) {
      throw new Error(`Not a ZIM file (bad magic 0x${magic.toString(16)}): ${this.filePath}`);
    }
    this.header = {
      majorVersion: b.readUInt16LE(4),
      minorVersion: b.readUInt16LE(6),
      uuid: b.subarray(8, 24).toString('hex'),
      entryCount: b.readUInt32LE(24),
      clusterCount: b.readUInt32LE(28),
      urlPtrPos: readU64(b, 32),
      titlePtrPos: readU64(b, 40),
      clusterPtrPos: readU64(b, 48),
      mimeListPos: readU64(b, 56),
      mainPage: b.readUInt32LE(64),
      layoutPage: b.readUInt32LE(68),
      checksumPos: readU64(b, 72),
    };
  }

  _readMimeList() {
    // Null-terminated strings, terminated by an empty string.
    const chunk = this._read(4096, this.header.mimeListPos);
    const out = [];
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0) continue;
      if (i === start) break; // empty string -> end of list
      out.push(chunk.subarray(start, i).toString('utf8'));
      start = i + 1;
    }
    this.mimeTypes = out;
  }

  get entryCount() {
    return this.header.entryCount;
  }

  /** File offset of directory entry `index` (index into the URL-ordered list). */
  _direntOffset(index) {
    const b = this._read(8, this.header.urlPtrPos + index * 8);
    return readU64(b, 0);
  }

  /**
   * Parse the directory entry at `index`. Entries are variable length because
   * path and title are inline null-terminated strings, so we read a generous
   * window and parse forward.
   */
  dirent(index) {
    // Models hand us invented ids, so this is a real input boundary, not a
    // theoretical one: without the check we read past the end of the file.
    if (!Number.isInteger(index) || index < 0 || index >= this.header.entryCount) {
      throw new Error(`Entry ${index} is out of range (this archive has ${this.header.entryCount} entries).`);
    }

    const cached = this.direntCache.get(index);
    if (cached) return cached;

    const offset = this._direntOffset(index);
    const b = this._read(2048, offset);
    const mimeIdx = b.readUInt16LE(0);
    const namespace = String.fromCharCode(b[3]);

    const entry = {
      index,
      mimeIdx,
      namespace,
      isRedirect: mimeIdx === MIME_REDIRECT,
      mimeType: null,
    };

    let p;
    if (mimeIdx === MIME_REDIRECT) {
      entry.redirectIndex = b.readUInt32LE(8);
      p = 12;
    } else if (mimeIdx === MIME_LINKTARGET || mimeIdx === MIME_DELETED) {
      p = 8;
    } else {
      entry.clusterNumber = b.readUInt32LE(8);
      entry.blobNumber = b.readUInt32LE(12);
      entry.mimeType = this.mimeTypes[mimeIdx] || null;
      p = 16;
    }

    const zero = b.indexOf(0, p);
    entry.path = b.subarray(p, zero === -1 ? p : zero).toString('utf8');
    const zero2 = b.indexOf(0, zero + 1);
    const rawTitle = b.subarray(zero + 1, zero2 === -1 ? zero + 1 : zero2).toString('utf8');
    // Per spec an empty title means "same as path".
    entry.title = rawTitle || entry.path;

    this.direntCache.set(index, entry);
    return entry;
  }

  /** Lowest index in the URL-ordered list that is >= (ns, path). */
  _urlLowerBound(ns, path) {
    let lo = 0;
    let hi = this.header.entryCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const e = this.dirent(mid);
      if (ZimReader._cmp(e.namespace, e.path, ns, path) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Exact entry lookup by namespace and path, or null. */
  findByPath(ns, path) {
    const i = this._urlLowerBound(ns, path);
    if (i >= this.header.entryCount) return null;
    const e = this.dirent(i);
    return e.namespace === ns && e.path === path ? e : null;
  }

  /**
   * The title-ordered listing: uint32 indices into the URL-ordered list, sorted
   * by (namespace, title).
   *
   * Where it lives depends on the ZIM generation. Up to ZIM 6.0 the header's
   * titlePtrPos pointed straight at it. From 6.1 on that field is set to all-ones
   * and the listing moved into a regular entry, X/listing/titleOrdered/v1
   * (articles only) with v0 as the all-entries variant. We try the header first,
   * then fall back to the entries.
   */
  _loadTitleOrder() {
    if (this._titleOrder) return this._titleOrder;

    const fileSize = fs.fstatSync(this.fd).size;
    const pos = this.header.titlePtrPos;
    if (Number.isSafeInteger(pos) && pos > 0 && pos + this.header.entryCount * 4 <= fileSize) {
      const buf = this._read(this.header.entryCount * 4, pos);
      if (buf.length === this.header.entryCount * 4) {
        this._titleOrder = new Uint32Array(buf.buffer, buf.byteOffset, this.header.entryCount);
        return this._titleOrder;
      }
    }

    // v1 lists only real articles, which is exactly what search should consider.
    for (const name of ['listing/titleOrdered/v1', 'listing/titleOrdered/v0']) {
      const entry = this.findByPath('X', name);
      if (!entry) continue;
      const blob = this.blob(entry);
      if (blob.length < 4) continue;
      const count = Math.floor(blob.length / 4);
      // Copy: the blob is a view into a cached cluster that may be evicted.
      const arr = new Uint32Array(count);
      for (let i = 0; i < count; i++) arr[i] = blob.readUInt32LE(i * 4);
      this._titleOrder = arr;
      return this._titleOrder;
    }

    throw new Error(
      'This ZIM has no readable title index. It may be corrupt or an unsupported format version.'
    );
  }

  /** Number of entries reachable through the title listing. */
  get titleCount() {
    return this._loadTitleOrder().length;
  }

  /** Entry at position `i` of the title-ordered listing. */
  _titleEntry(i) {
    return this.dirent(this._loadTitleOrder()[i]);
  }

  /**
   * The content namespace differs between ZIM generations: 'A' in the old
   * layout, 'C' since ZIM 6. Probe the middle of the archive to decide.
   */
  contentNamespace() {
    if (this._ns) return this._ns;
    const counts = {};
    const n = this.titleCount;
    for (let i = 0; i < 40; i++) {
      const e = this._titleEntry(Math.floor((n * i) / 40));
      counts[e.namespace] = (counts[e.namespace] || 0) + 1;
    }
    this._ns = counts.C >= (counts.A || 0) ? 'C' : 'A';
    return this._ns;
  }

  /** Order key matching the file's own sort: namespace first, then title. */
  static _cmp(nsA, titleA, nsB, titleB) {
    if (nsA !== nsB) return nsA < nsB ? -1 : 1;
    if (titleA === titleB) return 0;
    return titleA < titleB ? -1 : 1;
  }

  /** Lowest position in the title listing that is >= (ns, title). */
  _lowerBound(ns, title) {
    let lo = 0;
    let hi = this.titleCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const e = this._titleEntry(mid);
      if (ZimReader._cmp(e.namespace, e.title, ns, title) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Find candidate articles for a query.
   *
   * Strategy: jump to where the query would sort, then score a window of
   * neighbours by token overlap. This handles exact titles, prefixes, and
   * near-misses ("ada lovelace" -> "Ada Lovelace") without a full-text index.
   */
  search(query, limit = 5) {
    const ns = this.contentNamespace();
    const cleaned = String(query).trim();
    if (!cleaned) return [];

    const variants = dedupe([
      cleaned,
      titleCase(cleaned),
      cleaned.replace(/\s+/g, '_'),
      titleCase(cleaned).replace(/\s+/g, '_'),
      cleaned.charAt(0).toUpperCase() + cleaned.slice(1),
    ]);

    const wanted = tokens(cleaned);
    const seen = new Set();
    const scored = [];

    for (const variant of variants) {
      const start = this._lowerBound(ns, variant);
      // Look slightly behind as well: the query may sort just after its target.
      for (let i = Math.max(0, start - 3); i < Math.min(this.titleCount, start + 40); i++) {
        const e = this._titleEntry(i);
        if (e.namespace !== ns) continue;
        if (seen.has(e.index)) continue;
        // Skip non-article assets (images, stylesheets) that share the namespace.
        if (!e.isRedirect && e.mimeType && !e.mimeType.startsWith('text/html')) continue;
        seen.add(e.index);
        scored.push({ entry: e, score: scoreTitle(e.title, cleaned, wanted) });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored
      .filter((s) => s.score > 0)
      .slice(0, limit)
      .map((s) => ({ title: s.entry.title, path: s.entry.path, index: s.entry.index, score: s.score }));
  }

  /** Resolve redirects to the underlying content entry. */
  resolve(entry, depth = 0) {
    if (!entry.isRedirect || depth > 5) return entry;
    return this.resolve(this.dirent(entry.redirectIndex), depth + 1);
  }

  _clusterBounds(i) {
    const b = this._read(8, this.header.clusterPtrPos + i * 8);
    const start = readU64(b, 0);
    let end;
    if (i + 1 < this.header.clusterCount) {
      end = readU64(this._read(8, this.header.clusterPtrPos + (i + 1) * 8), 0);
    } else {
      end = this.header.checksumPos || fs.fstatSync(this.fd).size;
    }
    return { start, end };
  }

  _cluster(i) {
    const cached = this.clusterCache.get(i);
    if (cached) return cached;

    const { start, end } = this._clusterBounds(i);
    const info = this._read(1, start)[0];
    const compression = info & 0x0f;
    const extended = (info & 0x10) !== 0;
    const payload = this._read(end - start - 1, start + 1);

    let data;
    switch (compression) {
      case COMP_ZSTD:
        data = zlib.zstdDecompressSync(payload);
        break;
      case COMP_NONE:
      case COMP_NONE_OLD:
        data = payload;
        break;
      case COMP_ZLIB:
        data = zlib.inflateSync(payload);
        break;
      case COMP_LZMA:
        throw new Error(
          'This ZIM uses LZMA compression, which Verity cannot read. ' +
            'Download a current Kiwix ZIM (2021 or later) — those use zstd.'
        );
      case COMP_BZIP2:
        throw new Error('This ZIM uses bzip2 compression, which Verity cannot read.');
      default:
        throw new Error(`Unknown ZIM cluster compression type: ${compression}`);
    }

    // Blob offset table: offsetCount is derived from the first offset, since the
    // table sits immediately before the blob data it points at.
    const width = extended ? 8 : 4;
    const first = extended ? readU64(data, 0) : data.readUInt32LE(0);
    const count = first / width;
    const offsets = new Array(count);
    for (let k = 0; k < count; k++) {
      offsets[k] = extended ? readU64(data, k * width) : data.readUInt32LE(k * width);
    }

    const cluster = { data, offsets };
    this.clusterCache.set(i, cluster);
    return cluster;
  }

  /** Raw bytes for an entry (redirects followed). */
  blob(entry) {
    const target = this.resolve(entry);
    if (target.clusterNumber === undefined) return Buffer.alloc(0);
    const cluster = this._cluster(target.clusterNumber);
    const b = target.blobNumber;
    if (b + 1 >= cluster.offsets.length) return Buffer.alloc(0);
    return cluster.data.subarray(cluster.offsets[b], cluster.offsets[b + 1]);
  }

  /** An entry's content as readable plain text. */
  text(entry, maxChars = 6000) {
    const target = this.resolve(entry);
    const html = this.blob(target).toString('utf8');
    return { title: target.title, path: target.path, text: htmlToText(html, maxChars) };
  }

  byIndex(index) {
    return this.dirent(index);
  }

  metadata(name) {
    // Metadata lives in namespace 'M' under its own name, e.g. M/Title. It is
    // looked up through the URL list because the title listing may exclude it.
    const e = this.findByPath('M', name);
    return e ? this.blob(e).toString('utf8') : null;
  }

  info() {
    let title = null;
    let date = null;
    try {
      title = this.metadata('Title');
      date = this.metadata('Date');
    } catch {
      /* metadata is optional */
    }
    return {
      path: this.filePath,
      title,
      date,
      entryCount: this.header.entryCount,
      clusterCount: this.header.clusterCount,
      zimVersion: `${this.header.majorVersion}.${this.header.minorVersion}`,
    };
  }
}

function dedupe(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function titleCase(s) {
  const small = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'and', 'or', 'to', 'for']);
  return s
    .split(/\s+/)
    .map((w, i) => (i > 0 && small.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function tokens(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Rank a candidate title against the query. Exact and prefix matches dominate;
 * otherwise fall back to how much of the query the title covers, with a penalty
 * for long titles so "Telephone" beats "Telephone numbers in Zambia".
 */
function scoreTitle(candidate, query, wantedTokens) {
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  if (c === q) return 1000;
  if (c === q.replace(/_/g, ' ')) return 1000;

  const candTokens = tokens(candidate);
  if (!candTokens.length) return 0;

  const overlap = wantedTokens.filter((t) => candTokens.includes(t)).length;
  if (!overlap) return c.startsWith(q) ? 40 : 0;

  const coverage = overlap / wantedTokens.length;
  let score = coverage * 200;
  if (c.startsWith(q)) score += 120;
  // Prefer concise titles: extra words usually mean a narrower sub-topic.
  score -= Math.max(0, candTokens.length - wantedTokens.length) * 8;
  return Math.max(score, 1);
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', deg: '°', times: '×', minus: '−',
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] !== undefined ? ENTITIES[e] : m;
  });
}

/**
 * Turn a Wikipedia article body into text a language model can use.
 * Strips chrome (scripts, infobox tables, edit links, reference markers) and
 * keeps headings as markdown so the model can see the article's structure.
 */
function htmlToText(html, maxChars) {
  let s = html;
  s = s.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // Reference superscripts and edit affordances add noise but no information.
  s = s.replace(/<sup\b[^>]*class="[^"]*reference[^"]*"[^>]*>[\s\S]*?<\/sup>/gi, '');
  s = s.replace(/<span\b[^>]*class="[^"]*mw-editsection[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '');
  s = s.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, ' ');
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (m, lvl, inner) => `\n\n${'#'.repeat(Number(lvl))} ${inner}\n`);
  s = s.replace(/<\/(p|div|li|tr|section)>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t ]+/g, ' ');
  // Work line-wise from here: stripping tags leaves a lot of whitespace-only
  // lines, and the Wikipedia chrome that survives is easiest to spot by line shape.
  let lines = s.split('\n').map((l) => l.trim()).filter(Boolean);

  // Drop the appendices — mostly citation soup, and context is scarce on 8GB.
  const APPENDIX = /^#+\s*(references|external links|further reading|notes|bibliography|see also|citations|sources)\b/i;
  const cutIdx = lines.findIndex((l) => APPENDIX.test(l));
  // Only trim when real prose precedes the heading, so a stub that opens with
  // "References" is not reduced to nothing.
  if (cutIdx > 0 && lines.slice(0, cutIdx).some((l) => !l.startsWith('#'))) {
    lines = lines.slice(0, cutIdx);
  }

  // Navboxes and sidebars render as a run of very short lines ahead of the lead
  // paragraph. Once the lead is found, drop everything before it except headings,
  // which carry the article's structure.
  const lead = lines.findIndex((l) => l.length >= 120 && !l.startsWith('#'));
  if (lead > 0) lines = lines.filter((l, i) => i >= lead || l.startsWith('#'));

  s = lines.join('\n').replace(/\n(#)/g, '\n\n$1').trim();

  if (s.length > maxChars) {
    // Cut on a paragraph boundary when one is close, so we never end mid-sentence.
    const cut = s.lastIndexOf('\n\n', maxChars);
    s = s.slice(0, cut > maxChars * 0.6 ? cut : maxChars).trimEnd() + '\n\n[…article truncated]';
  }
  return s;
}

module.exports = { ZimReader, htmlToText, scoreTitle };
