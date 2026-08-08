#!/usr/bin/env node
'use strict';
/**
 * Verify a ZIM archive outside the app: open it, print what it is, and run a
 * lookup. Useful for confirming a long download actually landed intact.
 *
 *   node scripts/check-wikipedia.js [path-to.zim] [search terms]
 */

const fs = require('fs');
const path = require('path');
const { ZimReader } = require('../src/main/zim/reader');

const SEARCH_DIRS = ['/Volumes', path.join(process.env.HOME, 'Documents'), path.join(process.env.HOME, 'Downloads')];

function findArchives() {
  const found = [];
  for (const base of SEARCH_DIRS) {
    let roots;
    try {
      roots = base === '/Volumes' ? fs.readdirSync(base).map((d) => path.join(base, d)) : [base];
    } catch {
      continue;
    }
    for (const root of roots) {
      for (const dir of [root, path.join(root, 'zim'), path.join(root, 'kiwix'), path.join(root, 'Wikipedia')]) {
        let names;
        try {
          names = fs.readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.toLowerCase().endsWith('.zim')) continue;
          const full = path.join(dir, name);
          try {
            found.push({ path: full, bytes: fs.statSync(full).size });
          } catch {
            /* unreadable */
          }
        }
      }
    }
  }
  return found.sort((a, b) => b.bytes - a.bytes);
}

const args = process.argv.slice(2);
let file = args[0] && args[0].endsWith('.zim') ? args[0] : null;
const query = (file ? args.slice(1) : args).join(' ') || 'Photosynthesis';

if (!file) {
  const archives = findArchives();
  if (!archives.length) {
    console.error('No .zim archive found in /Volumes, ~/Documents or ~/Downloads.');
    console.error('Plug in the drive, or pass a path: node scripts/check-wikipedia.js /path/to/file.zim');
    process.exit(1);
  }
  console.log(`Found ${archives.length} archive(s):`);
  for (const a of archives) console.log(`  ${(a.bytes / 1e9).toFixed(2)} GB  ${a.path}`);
  file = archives[0].path;
  console.log('');
}

console.log(`Opening ${file}…\n`);

let zim;
try {
  zim = new ZimReader(file).open();
} catch (err) {
  console.error(`FAILED: ${err.message}`);
  console.error('\nA truncated download is the usual cause. Re-run the curl command with -C - to resume.');
  process.exit(1);
}

try {
  const info = zim.info();
  console.log(`  Title      ${info.title || '(none)'}`);
  console.log(`  Date       ${info.date || '(none)'}`);
  console.log(`  Entries    ${info.entryCount.toLocaleString()}`);
  console.log(`  Articles   ${zim.titleCount.toLocaleString()}`);
  console.log(`  ZIM format ${info.zimVersion}`);
  console.log(`  Namespace  ${zim.contentNamespace()}\n`);

  console.log(`Searching for "${query}"…`);
  const hits = zim.search(query, 5);
  if (!hits.length) {
    console.log('  No matches. Try a plain subject name, e.g. "Photosynthesis".');
  } else {
    for (const h of hits) console.log(`  - ${h.title}`);
    const article = zim.text(zim.byIndex(hits[0].index), 400);
    console.log(`\nFirst article — ${article.title}:\n`);
    console.log(article.text.split('\n').filter(Boolean).slice(0, 4).join('\n'));
  }
  console.log('\nArchive is readable. Verity will use it.');
} finally {
  zim.close();
}
