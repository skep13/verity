'use strict';
/**
 * Semantic index over the Obsidian vault.
 *
 * Keyword search is fine for a handful of notes and useless for hundreds: ask
 * "when is my dissertation due" and it will not find a note saying "thesis
 * deadline". Embeddings fix that, and Ollama already serves them locally, so
 * this stays entirely offline — no service, no API key, nothing leaving the Mac.
 *
 * How it works:
 *   Notes are split into overlapping passages, because retrieving a whole file
 *   wastes the context a 3B model has and buries the relevant line.
 *   Each passage is embedded once and cached; re-indexing only touches files
 *   whose modification time has changed.
 *   Search blends cosine similarity with keyword overlap, which recovers exact
 *   names and numbers that embeddings alone are weak on.
 *
 * Vectors are stored as base64 Float32 rather than JSON numbers: for a few
 * thousand passages that is the difference between a ~5 MB index and a ~60 MB one.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { load } = require('../config');

const EMBED_MODEL = 'nomic-embed-text';
const INDEX_VERSION = 1;

const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 150;
const MIN_CHUNK = 80;
// Ollama embeds a batch in one call; too large a batch stalls a small machine.
const BATCH = 16;

let index = null;      // { version, model, files: { [relPath]: { mtime, chunks: [{text, vec}] } } }
let indexing = false;
let pending = false;

function indexPath() {
  return path.join(app.getPath('userData'), 'vault-index.json');
}

function host() {
  return load().ollamaHost;
}

/* ------------------------------------------------------------------ */
/* Vector storage                                                      */
/* ------------------------------------------------------------------ */

function packVector(arr) {
  const f32 = Float32Array.from(arr);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

function unpackVector(b64) {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Vectors from Ollama are already unit length, but normalise defensively. */
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ------------------------------------------------------------------ */
/* Chunking                                                            */
/* ------------------------------------------------------------------ */

/**
 * Split a note into overlapping passages on paragraph boundaries, keeping the
 * note title on each so a passage still says what it belongs to once retrieved.
 */
function chunkNote(title, body) {
  const clean = String(body)
    .replace(/^---\n[\s\S]*?\n---\n/, '')   // drop frontmatter
    .replace(/\r/g, '')
    .trim();
  if (!clean) return [];

  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  const flush = () => {
    const text = current.trim();
    if (text.length >= MIN_CHUNK) chunks.push(`${title}\n\n${text}`);
    else if (text && chunks.length) chunks[chunks.length - 1] += `\n${text}`;
    else if (text) chunks.push(`${title}\n\n${text}`);
    current = '';
  };

  for (const para of paragraphs) {
    if (current && current.length + para.length > CHUNK_CHARS) {
      const previous = current;
      flush();
      // Carry the tail of the previous passage so a fact split across the
      // boundary is still retrievable from both sides.
      current = previous.slice(-CHUNK_OVERLAP);
    }
    current += (current ? '\n\n' : '') + para;
  }
  flush();

  return chunks;
}

/* ------------------------------------------------------------------ */
/* Embedding                                                           */
/* ------------------------------------------------------------------ */

async function embedBatch(texts) {
  const res = await fetch(`${host()}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (/not found|no such model/i.test(detail)) {
      throw new Error(`The embedding model is not installed. Run: ollama pull ${EMBED_MODEL}`);
    }
    throw new Error(`Embedding failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.embeddings || [];
}

async function embedOne(text) {
  const [vec] = await embedBatch([text]);
  return vec;
}

async function isAvailable() {
  try {
    const res = await fetch(`${host()}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json();
    return (data.models || []).some((m) => String(m.name).startsWith(EMBED_MODEL));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Index lifecycle                                                     */
/* ------------------------------------------------------------------ */

function loadIndex() {
  if (index) return index;
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    if (raw.version === INDEX_VERSION && raw.model === EMBED_MODEL) {
      index = raw;
      return index;
    }
  } catch {
    /* no usable index yet */
  }
  index = { version: INDEX_VERSION, model: EMBED_MODEL, files: {} };
  return index;
}

function saveIndex() {
  if (!index) return;
  fs.mkdirSync(path.dirname(indexPath()), { recursive: true });
  fs.writeFileSync(indexPath(), JSON.stringify(index));
}

/**
 * Bring the index up to date. Only files whose mtime changed are re-embedded,
 * so the usual run costs nothing. Safe to call often.
 */
async function reindex({ onProgress } = {}) {
  if (indexing) {
    pending = true;
    return { skipped: true };
  }
  indexing = true;

  try {
    // Required lazily: obsidian.js pulls in config, and requiring it at module
    // load would make this file impossible to test in isolation.
    const obsidian = require('../tools/obsidian');
    const root = obsidian.vaultRoot();
    const idx = loadIndex();

    const files = obsidian.listMarkdownFiles();
    const present = new Set();
    let embedded = 0;
    let changed = 0;

    for (const file of files) {
      const rel = path.relative(root, file);
      present.add(rel);

      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      const existing = idx.files[rel];
      if (existing && existing.mtime === stat.mtimeMs) continue;

      let body;
      try {
        body = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }

      const title = path.basename(rel, '.md');
      const chunks = chunkNote(title, body);
      if (!chunks.length) {
        idx.files[rel] = { mtime: stat.mtimeMs, chunks: [] };
        continue;
      }

      const stored = [];
      for (let i = 0; i < chunks.length; i += BATCH) {
        const slice = chunks.slice(i, i + BATCH);
        const vectors = await embedBatch(slice);
        slice.forEach((text, j) => {
          if (vectors[j]) stored.push({ text, vec: packVector(vectors[j]) });
        });
        embedded += slice.length;
        if (onProgress) onProgress({ file: rel, embedded });
      }

      idx.files[rel] = { mtime: stat.mtimeMs, chunks: stored };
      changed++;
    }

    // Forget notes that have been deleted or renamed.
    let removed = 0;
    for (const rel of Object.keys(idx.files)) {
      if (!present.has(rel)) {
        delete idx.files[rel];
        removed++;
      }
    }

    saveIndex();
    return { files: files.length, changed, removed, passages: embedded };
  } finally {
    indexing = false;
    if (pending) {
      pending = false;
      // A change arrived mid-run; catch up without blocking this caller.
      setTimeout(() => reindex().catch(() => {}), 500);
    }
  }
}

let scheduled = null;

/**
 * Queue a background re-index.
 *
 * Called whenever a note is written. Debounced because a single request can
 * produce several writes, and coalescing them means one pass instead of five.
 * Failures are swallowed on purpose: if Ollama is down, saving a note must still
 * succeed — the note is on disk either way, and the next run will pick it up.
 */
function scheduleReindex(delay = 4000) {
  if (scheduled) clearTimeout(scheduled);
  scheduled = setTimeout(() => {
    scheduled = null;
    reindex().catch(() => {});
  }, delay);
  if (scheduled.unref) scheduled.unref();
}

function stats() {
  const idx = loadIndex();
  const files = Object.keys(idx.files);
  const passages = files.reduce((n, f) => n + (idx.files[f].chunks?.length || 0), 0);
  return { files: files.length, passages, indexing };
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

function tokens(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2);
}

/**
 * Semantic search, blended with keyword overlap.
 *
 * Embeddings alone are weak on exact tokens — names, dates, invoice numbers —
 * so a keyword component is added rather than trusting similarity outright.
 */
async function search(query, limit = 6) {
  const idx = loadIndex();
  const entries = Object.entries(idx.files);
  if (!entries.length) return null;

  const queryVec = await embedOne(query);
  if (!queryVec) return null;
  const qv = Float32Array.from(queryVec);
  const wanted = tokens(query);

  const scored = [];
  for (const [rel, entry] of entries) {
    for (const chunk of entry.chunks || []) {
      const similarity = cosine(qv, unpackVector(chunk.vec));
      const lower = chunk.text.toLowerCase();
      const hits = wanted.filter((t) => lower.includes(t)).length;
      const keyword = wanted.length ? hits / wanted.length : 0;
      // Similarity leads; keyword overlap breaks ties and rescues exact terms.
      scored.push({ path: rel, text: chunk.text, score: similarity + keyword * 0.25, similarity });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // At most two passages per note, so one long note cannot crowd out the rest.
  const perFile = new Map();
  const results = [];
  for (const hit of scored) {
    if (hit.similarity < 0.28) break;
    const used = perFile.get(hit.path) || 0;
    if (used >= 2) continue;
    perFile.set(hit.path, used + 1);
    results.push({
      path: hit.path,
      title: path.basename(hit.path, '.md'),
      excerpt: hit.text.length > 700 ? `${hit.text.slice(0, 700)}…` : hit.text,
      relevance: Number(hit.similarity.toFixed(3)),
    });
    if (results.length >= limit) break;
  }

  return results;
}

module.exports = {
  reindex,
  scheduleReindex,
  search,
  stats,
  isAvailable,
  chunkNote,
  cosine,
  packVector,
  unpackVector,
  EMBED_MODEL,
};
