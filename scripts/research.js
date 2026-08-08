#!/usr/bin/env node
'use strict';
/**
 * Research a list of subjects and write a note on each into the vault.
 *
 *   node scripts/research.js "Photosynthesis" "Antikythera mechanism"
 *   node scripts/research.js --file topics.txt        one subject per line
 *   node scripts/research.js --web "quantum error correction"
 *
 * Offline Wikipedia is the default source because it is fixed, checkable and
 * works with no connection. --web adds a search on top for subjects the archive
 * cannot cover.
 *
 * Notes are written from retrieved text, not from the model's memory, and each
 * records where it came from. Run it over a long list and leave it: this is the
 * practical way to build a reference library the assistant can actually use.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
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

const config = require('../src/main/config');
const obsidian = require('../src/main/tools/obsidian');
const wikipedia = require('../src/main/tools/wikipedia');
const web = require('../src/main/tools/web');
const vault = require('../src/main/vault');
const ollama = require('../src/main/providers/ollama');

/** Ask the local model to turn retrieved text into a usable note. */
async function summarise(topic, sources, model) {
  const material = sources.map((s) => `SOURCE: ${s.label}\n\n${s.text}`).join('\n\n---\n\n');

  const messages = [
    {
      role: 'system',
      content: [
        'You write reference notes from supplied material.',
        '',
        'Rules:',
        '- Use ONLY the material given. If it does not say something, leave it out.',
        '- Never invent a figure, date or name. Accuracy matters more than completeness.',
        '- Write markdown: a short opening paragraph saying what the subject is, then "## Key facts" as a bullet list of the specific, checkable details — dates, numbers, names, mechanisms.',
        '- No preamble, no "here is a note", no offers of further help. Start with the paragraph.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `Write a reference note on "${topic}" from this material:\n\n${material.slice(0, 12000)}`,
    },
  ];

  const result = await ollama.chat({ model, messages, tools: [] });
  return result.content;
}

async function gather(topic, { useWeb }) {
  const sources = [];

  const hit = wikipedia.search({ query: topic, limit: 1 });
  if (hit.available && hit.results?.length) {
    const article = wikipedia.read({ id: hit.results[0].id, maxChars: 6000 });
    if (article.found) {
      sources.push({ label: `Offline Wikipedia — ${article.title}`, text: article.content, cite: article.title });
    }
  }

  if (useWeb) {
    const found = await web.search({ query: topic, limit: 3 });
    if (found.available && found.topPage) {
      sources.push({ label: `Web — ${found.topPage.title}`, text: found.topPage.extract, cite: found.topPage.url });
    }
  }

  return sources;
}

(async () => {
  const args = process.argv.slice(2);
  const useWeb = args.includes('--web');
  const filtered = args.filter((a) => a !== '--web');

  let topics = [];
  const fileIdx = filtered.indexOf('--file');
  if (fileIdx !== -1) {
    const file = filtered[fileIdx + 1];
    if (!file || !fs.existsSync(file)) {
      console.error('Give a readable file after --file, with one subject per line.');
      process.exit(1);
    }
    topics = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } else {
    topics = filtered;
  }

  if (!topics.length) {
    console.error('Give one or more subjects, or --file topics.txt');
    process.exit(1);
  }

  const cfg = config.load();
  const model = cfg.model;
  const wikiStatus = wikipedia.status();
  console.log(`Model     ${model}`);
  console.log(`Wikipedia ${wikiStatus.available ? wikiStatus.info?.title || 'connected' : 'not connected'}`);
  console.log(`Web       ${useWeb ? 'enabled' : 'off (pass --web to enable)'}`);
  console.log(`Topics    ${topics.length}\n`);

  let written = 0;
  for (const [i, topic] of topics.entries()) {
    process.stdout.write(`[${i + 1}/${topics.length}] ${topic} … `);
    try {
      const sources = await gather(topic, { useWeb });
      if (!sources.length) {
        console.log('skipped — nothing found');
        continue;
      }

      const body = await summarise(topic, sources, model);
      if (!body || body.length < 80) {
        console.log('skipped — no usable summary');
        continue;
      }

      const citations = sources.map((s) => `- ${s.label}`).join('\n');
      obsidian.write({
        title: topic,
        content: `${body}\n\n## Sources\n\n${citations}\n`,
        folder: 'Reference',
        tags: ['research'],
      });
      written++;
      console.log(`written (${body.length} chars, ${sources.length} source${sources.length === 1 ? '' : 's'})`);
    } catch (err) {
      console.log(`failed — ${err.message.slice(0, 80)}`);
    }
  }

  console.log(`\n${written} of ${topics.length} notes written to Reference/.`);
  if (written) {
    console.log('Indexing…');
    const result = await vault.reindex();
    console.log(`Indexed ${result.files} notes, ${result.passages} passages embedded.`);
  }
  wikipedia.closeAll();
})();
