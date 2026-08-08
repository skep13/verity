'use strict';
/**
 * Offline Wikipedia, backed by a Kiwix ZIM file — typically on a USB stick.
 *
 * The archive is discovered rather than configured: any .zim under /Volumes (or
 * the other search paths) is picked up, so plugging the stick in is all it takes.
 * When the stick is absent every call returns a clear, non-fatal message so the
 * model can tell you it needs the drive instead of inventing an answer.
 */

const fs = require('fs');
const path = require('path');
const { ZimReader } = require('../zim/reader');
const { load } = require('../config');

// path -> open reader. Kept open because reopening costs a header + index read.
const open = new Map();
let cachedScan = { at: 0, files: [] };
// Best hit from the most recent search, so a bare read() has something to use.
let lastSearchTop = null;

function discover({ force = false } = {}) {
  const now = Date.now();
  // Rescanning /Volumes on every call is wasteful; a few seconds of staleness is fine.
  if (!force && now - cachedScan.at < 5000) return cachedScan.files;

  const cfg = load();
  const found = [];
  const seen = new Set();

  for (const base of cfg.zim.searchPaths || []) {
    let roots = [];
    try {
      if (!fs.existsSync(base)) continue;
      // /Volumes holds mount points, so descend one level into each.
      roots = base === '/Volumes'
        ? fs.readdirSync(base).map((d) => path.join(base, d))
        : [base];
    } catch {
      continue;
    }

    for (const root of roots) {
      for (const dir of [root, path.join(root, 'zim'), path.join(root, 'kiwix'), path.join(root, 'Wikipedia')]) {
        let entries;
        try {
          entries = fs.readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of entries) {
          if (!name.toLowerCase().endsWith('.zim')) continue;
          const full = path.join(dir, name);
          if (seen.has(full)) continue;
          seen.add(full);
          try {
            found.push({ path: full, bytes: fs.statSync(full).size, name });
          } catch {
            /* unreadable: ignore */
          }
        }
      }
    }
  }

  // Biggest archive first — that is almost always the fullest Wikipedia.
  found.sort((a, b) => b.bytes - a.bytes);
  cachedScan = { at: now, files: found };

  // Drop readers whose file has gone away (stick unplugged).
  for (const [p, reader] of open) {
    if (!found.some((f) => f.path === p)) {
      try {
        reader.close();
      } catch {
        /* already gone */
      }
      open.delete(p);
    }
  }

  return found;
}

function activePath() {
  const cfg = load();
  const files = discover();
  if (cfg.zim.preferredPath && files.some((f) => f.path === cfg.zim.preferredPath)) {
    return cfg.zim.preferredPath;
  }
  return files.length ? files[0].path : null;
}

function reader() {
  const p = activePath();
  if (!p) return null;
  if (open.has(p)) return open.get(p);
  try {
    const r = new ZimReader(p).open();
    open.set(p, r);
    return r;
  } catch (err) {
    // A corrupt or half-copied archive should not take the app down.
    throw new Error(`Could not open the Wikipedia archive at ${path.basename(p)}: ${err.message}`);
  }
}

const UNAVAILABLE = {
  available: false,
  error:
    'The offline Wikipedia archive is not available — the USB drive holding it does not appear to be plugged in. ' +
    'Tell the user you need the drive connected, and answer from your own knowledge only if you are confident, saying so.',
};

function search({ query, limit = 5 }) {
  const r = reader();
  if (!r) return UNAVAILABLE;
  const results = r.search(query, Math.min(limit, 10));
  if (!results.length) {
    return {
      available: true,
      results: [],
      note: `No article titled anything like "${query}". Try the plain subject name, e.g. "Photosynthesis" rather than a full question.`,
    };
  }
  lastSearchTop = results[0].index;
  const out = {
    available: true,
    source: path.basename(activePath()),
    results: results.map((x) => ({ title: x.title, id: x.index })),
  };

  // Include the opening of the best match. Smaller models routinely answer
  // straight from a search without reading the article; handing them real text
  // here means that shortcut still produces a grounded answer instead of one
  // recited from memory — and it saves a whole round trip when the lead is enough.
  try {
    const top = r.text(r.byIndex(results[0].index), 900);
    out.topArticle = { title: top.title, id: results[0].index, extract: top.text };
  } catch {
    /* the extract is a bonus; a failure here must not fail the search */
  }
  return out;
}

/** Fetch article text by title or by an id returned from search. */
function read({ title, id, maxChars = 4000 }) {
  const r = reader();
  if (!r) return UNAVAILABLE;

  let entry = null;

  // Ids get hallucinated, so validate rather than trust, and degrade through
  // the title and then the last search rather than failing the call.
  const numeric = Number(id);
  if (id !== undefined && id !== null && Number.isInteger(numeric) && numeric >= 0 && numeric < r.entryCount) {
    entry = r.byIndex(numeric);
  }
  if (!entry && title) {
    const hits = r.search(title, 1);
    if (hits.length) entry = r.byIndex(hits[0].index);
  }
  if (!entry && lastSearchTop !== null) {
    // Called with nothing usable straight after a search: that search's best
    // hit is what was meant.
    entry = r.byIndex(lastSearchTop);
  }
  if (!entry) {
    return { available: true, found: false, note: `No article found for "${title ?? id}".` };
  }

  const article = r.text(entry, maxChars);
  return {
    available: true,
    found: true,
    title: article.title,
    source: `Offline Wikipedia (${path.basename(activePath())})`,
    content: article.text,
  };
}

function status() {
  const files = discover({ force: true });
  const active = activePath();
  let info = null;
  if (active) {
    try {
      info = reader().info();
    } catch (err) {
      return { available: false, error: err.message, archives: files };
    }
  }
  return {
    available: Boolean(active),
    active,
    info,
    archives: files.map((f) => ({ name: f.name, path: f.path, gb: +(f.bytes / 1e9).toFixed(2) })),
  };
}

function closeAll() {
  for (const r of open.values()) {
    try {
      r.close();
    } catch {
      /* ignore */
    }
  }
  open.clear();
}

module.exports = { search, read, status, discover, closeAll };
