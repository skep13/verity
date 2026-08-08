'use strict';
/**
 * Conversation memory.
 *
 * Until now a conversation lived only in the renderer: close Verity and it was
 * gone. Every exchange is now appended to a dated note in the vault's `chats`
 * folder, which the semantic index picks up, so "what did we decide about the
 * thesis last week" is answerable by the same vault search as everything else.
 *
 * Written per turn rather than at the end, because the end never reliably
 * arrives — people close the window, the machine sleeps, the app is quit from
 * the Dock.
 */

const fs = require('fs');
const path = require('path');
const { load } = require('./config');
const obsidian = require('./tools/obsidian');

let current = null; // { file, title, started }

function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** A title from the opening message: enough to recognise the conversation later. */
const OPENERS = /^(hey|hi|hello|ok|okay|so|well|um|please|could you|can you|would you|verity)\b[,.\s]*/i;

function titleFrom(text) {
  let clean = String(text).replace(/\s+/g, ' ').trim();

  // Strip openers repeatedly: "Hey Verity, what's on…" has two of them stacked,
  // and one pass leaves the wake word sitting at the front of every title.
  let previous;
  do {
    previous = clean;
    clean = clean.replace(OPENERS, '');
  } while (clean !== previous && clean);

  // Trailing punctuation would otherwise be turned into a dash by the filename
  // sanitiser, giving every question a title ending in "-".
  clean = clean.replace(/[?!.,;:]+$/, '').trim();
  if (!clean) return 'Conversation';

  const words = clean.split(' ').slice(0, 8).join(' ');
  const title = words.length > 56 ? `${words.slice(0, 56)}…` : words;
  return sanitize(title.charAt(0).toUpperCase() + title.slice(1)) || 'Conversation';
}

function chatsDir() {
  const cfg = load();
  return path.join(obsidian.vaultRoot(), cfg.chatsFolder || 'chats');
}

/** Start a new conversation file. Called on the first turn, and on "New conversation". */
function begin(firstMessage) {
  const now = new Date();
  const title = titleFrom(firstMessage);
  const dir = chatsDir();
  fs.mkdirSync(dir, { recursive: true });

  const stamp = `${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 5).replace(':', '')}`;
  let file = path.join(dir, `${stamp} ${title}.md`);
  let n = 2;
  while (fs.existsSync(file)) {
    file = path.join(dir, `${stamp} ${title} (${n++}).md`);
  }

  const header = [
    '---',
    `title: ${title}`,
    `date: ${now.toISOString()}`,
    'tags: [verity, conversation]',
    'source: verity',
    '---',
    '',
    `# ${title}`,
    '',
    `*${now.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })}*`,
    '',
  ].join('\n');

  fs.writeFileSync(file, header);
  current = { file, title, started: now };
  return current;
}

/**
 * Record one exchange. Tool activity is summarised rather than dumped: the
 * point of the log is what was asked and answered, not the machinery.
 */
function recordTurn({ user, assistant, toolsUsed }) {
  const cfg = load();
  if (cfg.saveConversations === false) return null;
  if (!user && !assistant) return null;

  try {
    if (!current) begin(user);

    const parts = [`**You:** ${String(user || '').trim()}`, ''];
    if (toolsUsed && toolsUsed.length) {
      const names = [...new Set(toolsUsed.map((t) => t.summary).filter(Boolean))];
      if (names.length) parts.push(`*(${names.join('; ')})*`, '');
    }
    parts.push(`**Verity:** ${String(assistant || '').trim()}`, '', '---', '');

    fs.appendFileSync(current.file, parts.join('\n'));

    // Let the index catch up in the background, debounced across turns.
    try {
      require('./vault').scheduleReindex(20000);
    } catch {
      /* indexing is optional */
    }

    return { file: current.file, title: current.title };
  } catch {
    // A vault that is unavailable must never break the conversation itself.
    return null;
  }
}

/** Close the current conversation so the next turn starts a fresh note. */
function end() {
  current = null;
}

function status() {
  if (!current) return { active: false };
  return {
    active: true,
    title: current.title,
    path: current.file,
    started: current.started.toISOString(),
  };
}

module.exports = { recordTurn, begin, end, status, titleFrom };
