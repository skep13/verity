#!/usr/bin/env node
'use strict';
/**
 * Import command-line tool documentation into the vault.
 *
 *   node scripts/import-tools.js            every tool in the list that is installed
 *   node scripts/import-tools.js nmap fls   just these
 *   node scripts/import-tools.js --list     show the list and what is installed
 *
 * Man pages are imported close to verbatim rather than summarised by the local
 * model. That is the whole point: a 3B model asked "what flag does fls need for
 * a deleted-file listing" will invent a plausible one, whereas retrieving the
 * actual page and answering from it cannot invent anything. Accuracy here comes
 * from the source, not the model.
 *
 * Pages vary from 4 KB to 170 KB, so sections are taken in order of usefulness —
 * what it is, how to invoke it, worked examples, then the detail — and capped.
 * Everything is chunked and embedded afterwards, so retrieval finds the relevant
 * passage rather than the whole page.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execSync } = require('child_process');
const Module = require('module');

const USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'Verity');
const ROOT = path.join(__dirname, '..');
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: { getPath: () => USER_DATA, getAppPath: () => ROOT },
      safeStorage: { isEncryptionAvailable: () => false },
      Notification: class {
        show() {}
      },
    };
  }
  return originalLoad.call(this, request, ...rest);
};

const obsidian = require('../src/main/tools/obsidian');
const vault = require('../src/main/vault');

/** Curated for digital forensics and incident response work. */
const CATALOGUE = {
  'Acquisition and imaging': ['dd', 'dcfldd', 'ewfacquire', 'ewfinfo', 'ewfverify', 'hdiutil', 'diskutil'],
  'Filesystem forensics': ['fls', 'icat', 'mmls', 'blkls', 'blkcat', 'istat', 'img_stat', 'fsstat', 'tsk_recover', 'tsk_gettimes'],
  'File and content analysis': ['file', 'strings', 'xxd', 'od', 'exiftool', 'binwalk', 'foremost', 'bulk_extractor', 'jq', 'sqlite3'],
  'Search': ['grep', 'rg', 'awk', 'sed', 'find', 'mdfind'],
  'Hashing and integrity': ['shasum', 'sha256sum', 'md5', 'md5deep', 'hashdeep', 'openssl', 'gpg'],
  'Network capture and analysis': ['tcpdump', 'tshark', 'nmap', 'ncat', 'nc', 'dig', 'whois', 'curl', 'ssh', 'lsof', 'netstat'],
  'Malware and binary analysis': ['otool', 'nm', 'objdump', 'codesign', 'spctl', 'yara', 'radare2'],
  'macOS forensics': ['plutil', 'mdls', 'log', 'fs_usage', 'dtrace', 'system_profiler', 'ioreg'],
};

// Most actionable first: a synopsis and a worked example answer more questions
// than an exhaustive options list, and the cap usually bites before OPTIONS.
const SECTION_PRIORITY = [
  'NAME', 'SYNOPSIS', 'EXAMPLES', 'EXAMPLE', 'DESCRIPTION', 'OPTIONS', 'FLAGS',
  'ARGUMENTS', 'COMMANDS', 'USAGE', 'ENVIRONMENT', 'EXIT STATUS', 'FILES', 'NOTES',
];
const MAX_CHARS = 11000;

function installed(tool) {
  try {
    execSync(`command -v ${tool}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, MANWIDTH: '100' } },
      (err, stdout, stderr) => resolve(`${stdout || ''}${stderr || ''}`));
  });
}

/** Split man output into { HEADING: body }. */
function parseSections(text) {
  const lines = text.split('\n');
  const sections = {};
  let current = null;
  let buffer = [];
  const flush = () => {
    if (current) sections[current] = buffer.join('\n').trim();
    buffer = [];
  };
  for (const line of lines) {
    if (/^[A-Z][A-Z0-9 /|,'-]{2,}$/.test(line.trimEnd()) && line === line.trimStart()) {
      flush();
      current = line.trim();
    } else if (current) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Does this output actually document the tool, rather than being an error or
 * the result of the tool doing something? Real help says "usage" or lists
 * flags; a permission error or a capture banner does neither.
 */
function looksLikeHelp(text) {
  if (!text || text.trim().length < 150) return false;
  if (/permission denied|not permitted|cannot open|command not found/i.test(text)) return false;
  const flagLines = text.split('\n').filter((l) => /^\s*-{1,2}[A-Za-z]/.test(l)).length;
  return /usage:|^usage\b/im.test(text) || flagLines >= 5;
}

/** Man output is indented by four spaces and full of blank runs. */
function tidy(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/\s+$/, '').replace(/^ {1,7}(?=\S)/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function documentFor(tool) {
  const man = await run('/usr/bin/man', [tool]);
  const clean = man.replace(/.\x08/g, ''); // man emits backspace-overstrike bold

  if (clean.trim().length > 200) {
    const sections = parseSections(clean);
    const names = Object.keys(sections);
    if (names.length) {
      const ordered = [
        ...SECTION_PRIORITY.filter((s) => sections[s]),
        ...names.filter((s) => !SECTION_PRIORITY.includes(s)),
      ];
      let out = '';
      let truncated = false;
      for (const name of ordered) {
        const body = tidy(sections[name]);
        if (!body) continue;
        const block = `## ${name}\n\n${body}\n\n`;
        if (out.length + block.length > MAX_CHARS) {
          const room = MAX_CHARS - out.length;
          if (room > 400) out += `## ${name}\n\n${body.slice(0, room - 120).trimEnd()}\n\n[…section truncated]\n\n`;
          truncated = true;
          break;
        }
        out += block;
      }
      return { text: out.trim(), source: 'man page', truncated };
    }
  }

  // Some tools ship no usable man page — tshark's is a single character on this
  // system — so fall back to what --help prints.
  //
  // Only real help flags are tried. A bare `help` argument was tried once and
  // tshark read it as a capture filter and began capturing on a live interface:
  // guessing subcommands runs whatever the tool decides that word means.
  //
  // The timeout is generous because the first invocation of a large tool is
  // slow — tshark loads its dissectors — and a killed --help previously fell
  // through to exactly that unsafe guess.
  for (const flag of ['--help', '-h']) {
    const help = await run(tool, [flag], 20000);
    if (looksLikeHelp(help)) {
      return { text: `## Usage\n\n\`\`\`\n${tidy(help).slice(0, MAX_CHARS)}\n\`\`\``, source: `${tool} ${flag}`, truncated: false };
    }
  }
  return null;
}

/** The one-line description from NAME, for the index note. */
function summaryOf(text) {
  const m = text.match(/## NAME\n\n(.+)/);
  if (!m) return '';
  return m[1].replace(/^\S+\s+[-–—]\s+/, '').trim().slice(0, 120);
}

(async () => {
  const args = process.argv.slice(2);
  const all = Object.entries(CATALOGUE).flatMap(([cat, tools]) => tools.map((t) => [t, cat]));

  if (args.includes('--list')) {
    for (const [cat, tools] of Object.entries(CATALOGUE)) {
      console.log(`\n${cat}`);
      for (const t of tools) console.log(`  ${installed(t) ? '✓' : ' '} ${t}`);
    }
    return;
  }

  const wanted = args.length ? all.filter(([t]) => args.includes(t)) : all;
  const vaultRoot = obsidian.vaultRoot();
  console.log(`Vault: ${vaultRoot}\n`);

  const written = [];
  const skipped = [];

  for (const [tool, category] of wanted) {
    if (!installed(tool)) {
      skipped.push([tool, 'not installed']);
      continue;
    }
    process.stdout.write(`  ${tool.padEnd(16)}`);
    let doc;
    try {
      doc = await documentFor(tool);
    } catch (err) {
      skipped.push([tool, err.message.slice(0, 40)]);
      console.log('failed');
      continue;
    }
    if (!doc) {
      skipped.push([tool, 'no man page or help output']);
      console.log('no documentation');
      continue;
    }

    const summary = summaryOf(doc.text);
    const body = [
      `> ${summary || `The \`${tool}\` command.`}`,
      '',
      `**Category:** ${category}  `,
      `**Source:** ${doc.source} on this machine${doc.truncated ? ', truncated' : ''}`,
      '',
      doc.text,
    ].join('\n');

    obsidian.write({ title: tool, content: body, folder: 'Tools', tags: ['tool', 'reference', 'cybersec'] });
    written.push([tool, category, summary]);
    console.log(`${(doc.text.length / 1000).toFixed(1)}k  ${summary.slice(0, 46)}`);
  }

  // An index note, so "what tools do I have for X" is answerable in one hop.
  if (written.length) {
    const byCategory = {};
    for (const [tool, category, summary] of written) {
      (byCategory[category] ||= []).push(`- [[${tool}]] — ${summary || 'see note'}`);
    }
    const index = Object.entries(byCategory)
      .map(([cat, lines]) => `## ${cat}\n\n${lines.join('\n')}`)
      .join('\n\n');
    obsidian.write({
      title: 'Tool index',
      content: `Command-line tools documented on this machine, imported from their own manuals.\n\n${index}`,
      folder: 'Tools',
      tags: ['tool', 'index'],
    });
  }

  console.log(`\n${written.length} imported, ${skipped.length} skipped.`);
  if (skipped.length) {
    const notInstalled = skipped.filter(([, why]) => why === 'not installed').map(([t]) => t);
    if (notInstalled.length) console.log(`  not installed: ${notInstalled.join(', ')}`);
    for (const [t, why] of skipped.filter(([, why]) => why !== 'not installed')) console.log(`  ${t}: ${why}`);
  }

  // Each write already queues a background re-index, so the first call here
  // usually collides with one and returns { skipped: true }. Wait it out rather
  // than reporting "undefined notes".
  console.log('\nIndexing…');
  let result = await vault.reindex();
  while (result.skipped) {
    await new Promise((r) => setTimeout(r, 2000));
    result = await vault.reindex();
  }
  const totals = vault.stats();
  console.log(`${totals.files} notes, ${totals.passages} passages in the index.`);
})();
