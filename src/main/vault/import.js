'use strict';
/**
 * Bring existing documents into the vault as notes.
 *
 * Conversion uses macOS's own `textutil`, which reads Word, RTF, ODT, HTML and
 * plain text without installing anything. PDFs it cannot do; those are skipped
 * with a reason unless `pdftotext` happens to be installed.
 *
 * Imported notes keep a pointer back to the original file, so Verity can say
 * where a fact came from and you can still open the real document.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// What textutil can convert directly.
const TEXTUTIL = new Set(['.doc', '.docx', '.rtf', '.rtfd', '.odt', '.html', '.htm', '.webarchive', '.wordml']);
// Read as-is.
const PLAIN = new Set(['.txt', '.md', '.markdown', '.text', '.csv', '.json', '.yaml', '.yml']);

const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', 'Library', '.Trash']);
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function hasPdfToText() {
  try {
    await run('/usr/bin/which', ['pdftotext'], 3000);
    return true;
  } catch {
    return false;
  }
}

/** Extract plain text from one document, or throw with a readable reason. */
async function extractText(file) {
  const ext = path.extname(file).toLowerCase();

  if (PLAIN.has(ext)) return fs.readFileSync(file, 'utf8');

  if (TEXTUTIL.has(ext)) {
    return run('/usr/bin/textutil', ['-convert', 'txt', '-stdout', file]);
  }

  if (ext === '.pdf') {
    if (await hasPdfToText()) return run('pdftotext', ['-layout', file, '-']);
    throw new Error('PDF needs pdftotext — install it with: brew install poppler');
  }

  throw new Error(`Unsupported file type ${ext || '(none)'}`);
}

function sanitizeName(name) {
  return String(name).replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
}

/** Collapse the runs of blank lines and hard-wrapped lines textutil leaves behind. */
function tidy(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Import one document. Returns what happened rather than throwing, so a bad
 * file in a folder of a hundred does not abort the run.
 */
async function importFile(file, { vaultRoot, folder = 'Imported', overwrite = false } = {}) {
  const name = path.basename(file);
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) {
      return { file: name, ok: false, reason: `too large (${(stat.size / 1e6).toFixed(1)} MB)` };
    }

    const raw = await extractText(file);
    const text = tidy(raw);
    if (text.length < 20) return { file: name, ok: false, reason: 'no readable text' };

    const dir = path.join(vaultRoot, folder);
    fs.mkdirSync(dir, { recursive: true });

    const title = sanitizeName(path.basename(file, path.extname(file)));
    let dest = path.join(dir, `${title}.md`);
    if (fs.existsSync(dest) && !overwrite) {
      // Two different documents can share a name; keep both rather than lose one.
      const stamp = new Date(stat.mtimeMs).toISOString().slice(0, 10);
      dest = path.join(dir, `${title} (${stamp}).md`);
      if (fs.existsSync(dest)) return { file: name, ok: false, reason: 'already imported' };
    }

    const frontmatter = [
      '---',
      `title: ${title}`,
      `source: ${file}`,
      `imported: ${new Date().toISOString()}`,
      'tags: [verity, imported]',
      '---',
      '',
      `# ${title}`,
      '',
      text,
      '',
    ].join('\n');

    fs.writeFileSync(dest, frontmatter);
    return { file: name, ok: true, note: path.relative(vaultRoot, dest), chars: text.length };
  } catch (err) {
    return { file: name, ok: false, reason: err.message.split('\n')[0].slice(0, 120) };
  }
}

function collectFiles(target, { recursive = true, depth = 0 } = {}) {
  const out = [];
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return out;
  }
  if (stat.isFile()) return [target];
  if (!stat.isDirectory() || depth > 8) return out;

  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(target, e.name);
    if (e.isDirectory()) {
      if (recursive) out.push(...collectFiles(full, { recursive, depth: depth + 1 }));
    } else {
      const ext = path.extname(e.name).toLowerCase();
      if (PLAIN.has(ext) || TEXTUTIL.has(ext) || ext === '.pdf') out.push(full);
    }
  }
  return out;
}

async function importPath(target, options = {}) {
  const files = collectFiles(target, options);
  const results = [];
  for (const file of files) {
    results.push(await importFile(file, options));
    if (options.onProgress) options.onProgress(results[results.length - 1], results.length, files.length);
  }
  return {
    found: files.length,
    imported: results.filter((r) => r.ok).length,
    skipped: results.filter((r) => !r.ok),
    results,
  };
}

module.exports = { importFile, importPath, collectFiles, extractText, tidy, PLAIN, TEXTUTIL };
