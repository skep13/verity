'use strict';
/**
 * Obsidian vault access.
 *
 * A vault is just a folder of markdown files, so we read and write it directly
 * rather than going through Obsidian itself. That means Verity's memory works
 * whether or not Obsidian is running, and notes it writes show up the next time
 * you open the app.
 *
 * Every path is resolved and confined to the vault root before any I/O.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('../config');

const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.DS_Store']);
const MAX_SCAN_FILES = 4000;

/** A directory is a vault if it contains Obsidian's `.obsidian` config folder. */
function isVault(dir) {
  try {
    return fs.existsSync(path.join(dir, '.obsidian'));
  } catch {
    return false;
  }
}

/**
 * Find the user's vault without being told where it is.
 *
 * Obsidian's own registry is consulted first, but it is not authoritative — it
 * happily keeps pointing at vaults that have since been moved or deleted — so
 * every candidate is checked against the disk before being accepted.
 */
function discoverVault() {
  const home = os.homedir();

  try {
    const registry = JSON.parse(
      fs.readFileSync(path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json'), 'utf8')
    );
    const vaults = Object.values(registry.vaults || {}).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    for (const v of vaults) {
      if (v.path && isVault(v.path)) return v.path;
    }
  } catch {
    /* Obsidian may not be installed, or the registry may be unreadable */
  }

  // Fall back to looking for a vault in the usual places, one level deep.
  const roots = [
    home,
    path.join(home, 'Documents'),
    path.join(home, 'ObsidianVault'),
    path.join(home, 'Obsidian'),
    path.join(home, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents'),
  ];

  for (const root of roots) {
    if (isVault(root)) return root;
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const candidate = path.join(root, e.name);
      if (isVault(candidate)) return candidate;
    }
  }

  return null;
}

function vaultRoot() {
  const configured = load().vaultPath;
  if (configured) {
    const root = path.resolve(configured);
    if (fs.existsSync(root)) return root;
  }

  const found = discoverVault();
  if (found) return found;

  throw new Error(
    configured
      ? `Obsidian vault not found at "${configured}". Set the correct path in Verity's settings.`
      : 'No Obsidian vault found. Set the path in Verity\'s settings.'
  );
}

/** Confine a relative path to the vault. Rejects traversal and absolute escapes. */
function safeJoin(relative) {
  const root = vaultRoot();
  const target = path.resolve(root, relative || '');
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('That path is outside the Obsidian vault, so Verity will not touch it.');
  }
  return target;
}

function sanitizeName(title) {
  const clean = String(title || '')
    .replace(/[\\/:*?"<>|#^[\]]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return clean || 'Untitled';
}

/** Recursively collect markdown files, bounded so a huge vault cannot stall the UI. */
function walk(dir, out = [], budget = { n: MAX_SCAN_FILES }) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (budget.n <= 0) return out;
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('._')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, budget);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      out.push(full);
      budget.n--;
    }
  }
  return out;
}

function tokens(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/** Absolute paths of every markdown file in the vault. Used by the indexer. */
function listMarkdownFiles() {
  return walk(vaultRoot());
}

/**
 * Search the vault.
 *
 * Tries the semantic index first, which finds notes by meaning — "dissertation
 * due" matching a note that says "thesis deadline". Falls back to keyword
 * scoring whenever the index is empty or Ollama is not up, so search never
 * simply stops working.
 */
async function search({ query, limit = 6 }) {
  const q = String(query || '').trim();
  if (!q) return { results: [], note: 'No query supplied.' };

  try {
    // Required here rather than at module load: the indexer requires this file.
    const semantic = await require('../vault').search(q, limit);
    if (semantic && semantic.length) {
      return { results: semantic, method: 'semantic' };
    }
  } catch {
    // An unavailable embedding model must not take vault search down with it.
  }

  return keywordSearch({ query: q, limit });
}

function keywordSearch({ query, limit = 6 }) {
  const root = vaultRoot();
  const q = String(query || '').trim();
  const wanted = tokens(q);
  const files = walk(root);
  const scored = [];

  for (const file of files) {
    const rel = path.relative(root, file);
    const name = path.basename(file, '.md');
    let body = '';
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const haystack = `${name}\n${body}`.toLowerCase();
    let score = 0;
    for (const t of wanted) {
      if (name.toLowerCase().includes(t)) score += 10;
      const hits = haystack.split(t).length - 1;
      score += Math.min(hits, 5);
    }
    if (name.toLowerCase() === q.toLowerCase()) score += 100;
    if (score <= 0) continue;

    // A snippet around the first hit is far more useful to the model than the head of the file.
    const idx = body.toLowerCase().indexOf(wanted[0]);
    const from = Math.max(0, idx - 120);
    const snippet = (idx === -1 ? body.slice(0, 240) : body.slice(from, from + 300))
      .replace(/\s+/g, ' ')
      .trim();

    scored.push({ path: rel, title: name, score, snippet });
  }

  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, limit).map(({ score, ...r }) => r);
  return {
    results,
    method: 'keyword',
    scanned: files.length,
    note: results.length ? undefined : 'No notes matched. The vault may not contain this yet.',
  };
}

function read({ path: rel, maxChars = 6000 }) {
  const target = safeJoin(rel.endsWith('.md') ? rel : `${rel}.md`);
  if (!fs.existsSync(target)) throw new Error(`No note at "${rel}".`);
  let text = fs.readFileSync(target, 'utf8');
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return { path: rel, content: text, truncated };
}

function list({ folder = '', limit = 100 } = {}) {
  const root = vaultRoot();
  const dir = safeJoin(folder);
  const files = walk(dir).slice(0, limit);
  return { folder: folder || '/', notes: files.map((f) => path.relative(root, f)) };
}

/**
 * Create or extend a note. This is Verity's long-term memory, so notes carry
 * frontmatter marking where they came from and when.
 */
function write({ title, content, folder, mode = 'create', tags = [] }) {
  const cfg = load();
  const root = vaultRoot();
  const dirRel = folder !== undefined && folder !== null ? folder : cfg.vaultFolder;
  const dir = safeJoin(dirRel);
  fs.mkdirSync(dir, { recursive: true });

  const name = sanitizeName(title);
  const file = path.join(dir, `${name}.md`);
  if (!file.startsWith(root + path.sep)) throw new Error('Refusing to write outside the vault.');

  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  const body = String(content ?? '').trim();
  const exists = fs.existsSync(file);

  if (exists && mode === 'append') {
    fs.appendFileSync(file, `\n\n## ${stamp}\n\n${body}\n`);
  } else if (exists && mode === 'create') {
    // Never silently clobber something you wrote by hand.
    fs.appendFileSync(file, `\n\n## ${stamp}\n\n${body}\n`);
    return {
      path: path.relative(root, file),
      action: 'appended',
      note: 'A note with that title already existed, so the text was appended instead of replacing it.',
    };
  } else {
    const tagList = [...new Set(['verity', ...(Array.isArray(tags) ? tags : [])])];
    const frontmatter = [
      '---',
      `title: ${name}`,
      `created: ${now.toISOString()}`,
      `tags: [${tagList.join(', ')}]`,
      'source: verity',
      '---',
      '',
      `# ${name}`,
      '',
      body,
      '',
    ].join('\n');
    fs.writeFileSync(file, frontmatter);
  }

  const relative = path.relative(root, file);

  // Link the note into the rest of the vault, then index it. Both run in the
  // background and are deliberately not awaited: neither should delay
  // confirming that the note was saved, and neither is allowed to fail the write.
  // Index before linking, not after: linking searches the index, and a note
  // written a moment ago is not in it yet. Re-indexing is incremental, so this
  // only embeds what actually changed. The trailing scheduleReindex then picks
  // up the "Related" section this appends.
  Promise.resolve()
    .then(() => require('../vault').reindex())
    .then(() => linkRelatedNotes(relative, body))
    .catch(() => {})
    .finally(() => {
      try {
        require('../vault').scheduleReindex();
      } catch {
        /* indexing is an optimisation, not a requirement */
      }
    });

  return { path: relative, action: exists ? 'appended' : 'created' };
}

/**
 * Append Obsidian [[wikilinks]] to the notes most related to this one.
 *
 * Relations come from the semantic index rather than shared keywords, so they
 * are actual connections rather than coincidences of vocabulary. This makes the
 * vault navigable as a graph inside Obsidian itself, and gives retrieval a
 * second route to a note.
 */
async function linkRelatedNotes(relativePath, body) {
  const cfg = load();
  const root = vaultRoot();
  const file = path.join(root, relativePath);
  const selfTitle = path.basename(relativePath, '.md');

  // The profile is context for every message, not a node in a graph.
  if (selfTitle === (cfg.profileNote || 'Profile')) return;

  const excerpt = String(body).slice(0, 600);
  const vault = require('../vault');

  let hits = null;
  try {
    hits = await vault.search(excerpt, 6);
  } catch {
    /* fall through to keyword matching */
  }

  // Without embeddings there is still a usable signal in shared vocabulary, so
  // linking degrades rather than disappearing when Ollama is unavailable.
  if (!hits || !hits.length) {
    const fallback = keywordSearch({ query: excerpt, limit: 6 });
    hits = (fallback.results || []).map((r) => ({ ...r, relevance: 0.55 }));
  }
  if (!hits.length) return;

  const seen = new Set([selfTitle]);
  const related = [];
  for (const hit of hits) {
    if (hit.path === relativePath) continue;
    if (seen.has(hit.title)) continue;
    // Only genuinely close notes; a weak match makes the graph noise.
    if (hit.relevance < 0.5) continue;
    seen.add(hit.title);
    related.push(hit.title);
    if (related.length >= 3) break;
  }
  if (!related.length) return;

  let current;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  if (/\n## Related\n/.test(current)) return; // already linked

  const section = `\n## Related\n\n${related.map((t) => `- [[${t}]]`).join('\n')}\n`;
  fs.appendFileSync(file, section);
}

/**
 * The profile note, loaded into every system prompt.
 *
 * A 3B model is unreliable at deciding to go and look something up, so the facts
 * it should never get wrong — who the user is, what they are working on, how
 * they like things done — are given to it for free on every turn. Capped,
 * because this is paid for out of the context window on every single message.
 */
function readProfile(maxChars = 2200) {
  const cfg = load();
  try {
    const file = path.join(vaultRoot(), cfg.vaultFolder, `${cfg.profileNote || 'Profile'}.md`);
    if (!fs.existsSync(file)) return null;
    let text = fs.readFileSync(file, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    if (!text) return null;
    if (text.length > maxChars) {
      const cut = text.lastIndexOf('\n', maxChars);
      text = `${text.slice(0, cut > maxChars * 0.5 ? cut : maxChars).trimEnd()}\n[…profile truncated]`;
    }
    return text;
  } catch {
    return null;
  }
}

/**
 * A compact table of contents for the vault, for the system prompt.
 *
 * Without this the model has no idea what it is holding: asked how to list
 * deleted files in a disk image it searched the web and invented a tool, while
 * the actual manual for `fls` sat in the vault and was retrievable in one hop.
 * Knowing the shelf exists is what makes it reach for it.
 */
function outline({ maxChars = 700, samplesPerFolder = 8 } = {}) {
  try {
    const root = vaultRoot();
    const cfg = load();
    const byFolder = new Map();

    for (const file of walk(root)) {
      const rel = path.relative(root, file);
      const dir = path.dirname(rel);
      const folder = dir === '.' ? '(top level)' : dir.split(path.sep)[0];
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder).push(path.basename(rel, '.md'));
    }
    if (!byFolder.size) return null;

    // Biggest first: that is where the useful bulk is.
    const folders = [...byFolder.entries()].sort((a, b) => b[1].length - a[1].length);
    const lines = [];
    for (const [folder, titles] of folders) {
      if (folder === cfg.vaultFolder) continue; // the profile is already inlined
      const sample = titles.slice(0, samplesPerFolder).join(', ');
      const more = titles.length > samplesPerFolder ? `, and ${titles.length - samplesPerFolder} more` : '';
      lines.push(`- **${folder}** (${titles.length}): ${sample}${more}`);
    }

    let out = lines.join('\n');
    if (out.length > maxChars) out = `${out.slice(0, maxChars).replace(/,[^,]*$/, '')}…`;
    return out || null;
  } catch {
    return null;
  }
}

function profilePath() {
  const cfg = load();
  return path.join(cfg.vaultFolder, `${cfg.profileNote || 'Profile'}.md`);
}

function status() {
  try {
    const root = vaultRoot();
    return { available: true, path: root, notes: walk(root).length };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

module.exports = {
  search,
  keywordSearch,
  read,
  write,
  list,
  status,
  vaultRoot,
  discoverVault,
  listMarkdownFiles,
  readProfile,
  profilePath,
  outline,
  linkRelatedNotes,
};
