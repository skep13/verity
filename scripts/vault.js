#!/usr/bin/env node
'use strict';
/**
 * Vault maintenance from the terminal — the practical way to load a lot of
 * material at once, rather than dictating it to Verity a sentence at a time.
 *
 *   node scripts/vault.js status
 *   node scripts/vault.js profile                 create the profile template
 *   node scripts/vault.js import ~/Documents ...  import documents as notes
 *   node scripts/vault.js index                   rebuild the semantic index
 *   node scripts/vault.js search "some question"  try a search
 *
 * Uses the same settings and index as the app, so anything done here is live in
 * Verity immediately.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// config.js expects Electron. Point it at the app's real settings directory so
// the CLI and the app share one index.
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

const config = require('../src/main/config');
const obsidian = require('../src/main/tools/obsidian');
const vault = require('../src/main/vault');
const { importPath } = require('../src/main/vault/import');

const PROFILE_TEMPLATE = `---
title: Profile
tags: [verity, profile]
---

# Profile

Everything in this note is loaded into Verity's context on every single message,
so it never has to look these things up. Keep it to what actually matters —
it is paid for out of the context window each time. A page is plenty.

## Who I am

- Name:
- What I do:
- Where I am (for weather and times):

## What I am working on

-

## People who come up

- Name — who they are

## How I want Verity to answer

- Keep spoken answers to two or three sentences.
- Say when you are unsure rather than guessing.
-

## Standing facts

- Deadlines, recurring commitments, anything that should never be got wrong.
-
`;

async function cmdStatus() {
  const status = obsidian.status();
  console.log(`Vault      ${status.available ? status.path : `unavailable — ${status.error}`}`);
  if (!status.available) return;
  console.log(`Notes      ${status.notes}`);
  const profile = obsidian.readProfile();
  console.log(`Profile    ${profile ? `${profile.length} chars, loaded every message` : `missing — run: node scripts/vault.js profile`}`);
  const idx = vault.stats();
  console.log(`Index      ${idx.files} files, ${idx.passages} passages`);
  console.log(`Embeddings ${(await vault.isAvailable()) ? `${vault.EMBED_MODEL} ready` : `missing — run: ollama pull ${vault.EMBED_MODEL}`}`);
}

function cmdProfile() {
  const cfg = config.load();
  const dir = path.join(obsidian.vaultRoot(), cfg.vaultFolder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${cfg.profileNote || 'Profile'}.md`);
  if (fs.existsSync(file)) {
    console.log(`Already exists: ${file}`);
    console.log('Edit it in Obsidian. Verity picks up changes on the next message.');
    return;
  }
  fs.writeFileSync(file, PROFILE_TEMPLATE);
  console.log(`Created ${file}`);
  console.log('Fill it in — this is the single biggest thing you can do for answer quality.');
}

async function cmdImport(targets) {
  if (!targets.length) {
    console.error('Give one or more files or folders to import.');
    process.exit(1);
  }
  const vaultRoot = obsidian.vaultRoot();
  let totalFound = 0;
  let totalImported = 0;

  for (const target of targets) {
    const resolved = path.resolve(target.replace(/^~/, os.homedir()));
    if (!fs.existsSync(resolved)) {
      console.error(`Not found: ${resolved}`);
      continue;
    }
    console.log(`\nImporting from ${resolved}`);
    const result = await importPath(resolved, {
      vaultRoot,
      folder: 'Imported',
      onProgress: (r, i, n) => {
        const label = r.ok ? `ok   ${r.note}` : `skip ${r.file} — ${r.reason}`;
        console.log(`  [${String(i).padStart(3)}/${n}] ${label}`);
      },
    });
    totalFound += result.found;
    totalImported += result.imported;
  }

  console.log(`\n${totalImported} of ${totalFound} imported.`);
  if (totalImported) {
    console.log('Indexing the new notes…');
    await cmdIndex();
  }
}

async function cmdIndex() {
  if (!(await vault.isAvailable())) {
    console.error(`The embedding model is missing. Run: ollama pull ${vault.EMBED_MODEL}`);
    process.exit(1);
  }
  const started = Date.now();
  let last = 0;
  const result = await vault.reindex({
    onProgress: ({ embedded }) => {
      // Only report every 25 passages; per-passage output is just noise.
      if (embedded - last >= 25) {
        last = embedded;
        process.stdout.write(`\r  embedded ${embedded} passages…`);
      }
    },
  });
  process.stdout.write('\r');
  console.log(
    `Indexed ${result.files} notes — ${result.changed} changed, ${result.removed} removed, ` +
      `${result.passages} passages embedded in ${((Date.now() - started) / 1000).toFixed(1)}s.`
  );
}

async function cmdSearch(query) {
  if (!query) {
    console.error('Give something to search for.');
    process.exit(1);
  }
  const result = await obsidian.search({ query, limit: 5 });
  console.log(`method: ${result.method}\n`);
  if (!result.results.length) {
    console.log(result.note || 'No matches.');
    return;
  }
  for (const hit of result.results) {
    console.log(`— ${hit.title}${hit.relevance ? `  (${hit.relevance})` : ''}`);
    console.log(`  ${hit.path}`);
    const text = (hit.excerpt || hit.snippet || '').replace(/\s+/g, ' ').slice(0, 180);
    console.log(`  ${text}\n`);
  }
}

(async () => {
  const [command, ...rest] = process.argv.slice(2);
  try {
    switch (command) {
      case 'status':
      case undefined:
        await cmdStatus();
        break;
      case 'profile':
        cmdProfile();
        break;
      case 'import':
        await cmdImport(rest);
        break;
      case 'index':
        await cmdIndex();
        break;
      case 'search':
        await cmdSearch(rest.join(' '));
        break;
      default:
        console.error(`Unknown command "${command}". Try: status, profile, import, index, search`);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Failed: ${err.message}`);
    process.exit(1);
  }
})();
