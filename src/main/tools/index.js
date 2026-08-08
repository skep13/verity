'use strict';
/**
 * Tool registry and permission gate.
 *
 * Permission is per tool and has three states:
 *   allow — runs without interrupting you
 *   ask   — prompts in the UI on every call, showing the exact arguments
 *   deny  — the tool is not even described to the model, so it cannot try
 *
 * Denied tools are withheld at schema level rather than refused at call time:
 * a model that never sees a tool cannot pester you about it.
 */

const obsidian = require('./obsidian');
const wikipedia = require('./wikipedia');
const { weather, datetime } = require('./weather');
const macos = require('./macos');
const web = require('./web');
const { load } = require('../config');

const TOOLS = [
  {
    name: 'obsidian_search',
    description:
      'Search the user\'s Obsidian vault — this is your long-term memory of things they have told you and research you saved earlier. Search here FIRST when asked about anything personal, previously discussed, or "what do you know about…".',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to look for in note titles and bodies.' },
        limit: { type: 'integer', description: 'Maximum notes to return (default 6).' },
      },
      required: ['query'],
    },
    run: (input) => obsidian.search(input),
    summarise: (i) => `search notes for “${i.query}”`,
  },
  {
    name: 'obsidian_read',
    description: 'Read the full text of one note in the Obsidian vault, using a path returned by obsidian_search.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Vault-relative path, e.g. "Verity/Photosynthesis.md".' } },
      required: ['path'],
    },
    run: (input) => obsidian.read(input),
    summarise: (i) => `read note ${i.path}`,
  },
  {
    name: 'obsidian_write',
    description:
      'Save something into the Obsidian vault so it is remembered permanently. Use this whenever the user tells you to remember something, or after you research a topic — write the findings up as a note. Prefer mode "append" when adding to an existing subject.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Note title — the subject, e.g. "Photosynthesis".' },
        content: { type: 'string', description: 'Markdown body to save. Write it up properly, not as a raw dump.' },
        mode: { type: 'string', enum: ['create', 'append'], description: 'Default "create".' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional extra tags.' },
      },
      required: ['title', 'content'],
    },
    run: (input) => obsidian.write(input),
    summarise: (i) => `save note “${i.title}” (${i.content ? i.content.length : 0} chars)`,
  },
  {
    name: 'obsidian_list',
    description: 'List note paths in the vault, optionally within a folder.',
    input_schema: {
      type: 'object',
      properties: { folder: { type: 'string', description: 'Vault-relative folder. Omit for the whole vault.' } },
    },
    run: (input) => obsidian.list(input || {}),
    summarise: (i) => `list notes in ${i.folder || 'the vault'}`,
  },
  {
    name: 'wikipedia_search',
    description:
      'Search the offline Wikipedia archive. Use the plain subject name ("Photosynthesis"), not a full question. Returns matching titles plus the opening of the best match, so for a simple question the extract alone is often enough. Call wikipedia_read for the full article when you need detail beyond the lead.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Subject name to look up.' },
        limit: { type: 'integer', description: 'Maximum titles to return (default 5).' },
      },
      required: ['query'],
    },
    run: (input) => wikipedia.search(input),
    summarise: (i) => `search Wikipedia for “${i.query}”`,
  },
  {
    name: 'wikipedia_read',
    description:
      'Read an article from the offline Wikipedia archive, by title or by an id from wikipedia_search. Base factual answers on the text this returns, and say the fact came from Wikipedia.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Article title.' },
        id: { type: 'integer', description: 'Article id from wikipedia_search (more reliable than title).' },
      },
    },
    run: (input) => wikipedia.read(input),
    summarise: (i) => `read Wikipedia article “${i.title || i.id}”`,
  },
  {
    name: 'weather',
    description:
      'Current conditions and forecast for a place. Requires an internet connection — it is live data and is NOT in the offline archive.',
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'Place name, e.g. "Edinburgh". Omit to use the saved location.' },
        days: { type: 'integer', description: 'Forecast days, 1-7. Default 1.' },
      },
    },
    run: (input) => weather(input || {}),
    summarise: (i) => `check the weather${i.location ? ` in ${i.location}` : ''}`,
  },
  {
    name: 'datetime',
    description:
      'The current local date, time and timezone. Call this before creating any calendar event or reminder from a relative time like "tomorrow" or "in an hour", so the date you calculate is right.',
    input_schema: { type: 'object', properties: {} },
    run: () => datetime(),
    summarise: () => 'check the current date and time',
  },
  {
    name: 'web_search',
    description:
      'Search the web. Use this for anything recent or changing — news, this year\'s events, current prices, releases, "the latest X" — which the offline Wikipedia archive cannot cover. Returns titles, addresses and snippets only; read a page with web_fetch before stating anything as fact.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms. Keywords work better than a full sentence.' },
        limit: { type: 'integer', description: 'Maximum results, default 6.' },
      },
      required: ['query'],
    },
    run: (input) => web.search(input),
    summarise: (i) => `search the web for “${i.query}”`,
  },
  {
    name: 'web_fetch',
    description:
      'Read a web page and return its text, using an address from web_search. Do this before answering from search results: snippets are too short to be trusted, and often misleading. Cannot read pages that need JavaScript, or PDFs.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http or https address to read.' },
        maxChars: { type: 'integer', description: 'How much text to return, default 5000.' },
      },
      required: ['url'],
    },
    run: (input) => web.fetchPage(input),
    summarise: (i) => {
      try {
        return `read ${new URL(i.url).hostname}`;
      } catch {
        return `read ${i.url}`;
      }
    },
  },
  {
    name: 'calendar_list',
    description: "What is on the user's calendar. Use this for questions like \"what's on today\", \"am I free this afternoon\", or before suggesting a time for something.",
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'How many days ahead to include, 1-31. Default 1 (today).' } },
    },
    run: (input) => macos.calendarList(input || {}),
    summarise: (i) => `check the calendar for the next ${i.days || 1} day(s)`,
  },
  {
    name: 'calendar_add',
    description:
      'Create an event in the calendar. Times must be ISO 8601 (2026-08-12T14:00) — call datetime first if the user said something relative. Omit the end time for a one hour event.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What the event is called.' },
        start: { type: 'string', description: 'ISO 8601 start, e.g. 2026-08-12T14:00.' },
        end: { type: 'string', description: 'ISO 8601 end. Defaults to an hour after the start.' },
        notes: { type: 'string', description: 'Optional detail for the event body.' },
        calendar: { type: 'string', description: 'Calendar name. Omit for the default.' },
      },
      required: ['title', 'start'],
    },
    run: (input) => macos.calendarAdd(input),
    summarise: (i) => `add “${i.title}” to the calendar on ${String(i.start || '').replace('T', ' at ')}`,
  },
  {
    name: 'reminder_add',
    description:
      'Add a reminder to the Reminders app. Prefer this over a calendar event for a task rather than an appointment, and for anything that must outlive Verity being open.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What to be reminded about.' },
        due: { type: 'string', description: 'Optional ISO 8601 due date and time.' },
        notes: { type: 'string', description: 'Optional detail.' },
      },
      required: ['title'],
    },
    run: (input) => macos.reminderAdd(input),
    summarise: (i) => `add a reminder to ${i.title}`,
  },
  {
    name: 'reminders_list',
    description: 'Outstanding reminders from the Reminders app, with their due dates. Use for "what do I need to do" or "what am I forgetting".',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Maximum reminders to return, default 25.' } },
    },
    run: (input) => macos.remindersList(input || {}),
    summarise: () => 'check outstanding reminders',
  },
  {
    name: 'clipboard_read',
    description:
      'Read what the user last copied. Use when they refer to something without pasting it — "what does this mean", "explain this error", "summarise what I just copied".',
    input_schema: { type: 'object', properties: {} },
    run: (input) => macos.clipboardRead(input || {}),
    summarise: () => 'read the clipboard',
  },
  {
    name: 'clipboard_write',
    description: 'Put text on the clipboard so the user can paste it somewhere else.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to copy.' } },
      required: ['text'],
    },
    run: (input) => macos.clipboardWrite(input),
    summarise: (i) => `copy ${i.text ? `${String(i.text).length} characters` : 'text'} to the clipboard`,
  },
  {
    name: 'timer_set',
    description:
      'Set a short timer that alerts when it elapses — for cooking, breaks, focus blocks. Only lasts while Verity is open; use reminder_add for anything longer term.',
    input_schema: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'How long, in minutes.' },
        label: { type: 'string', description: 'What the timer is for.' },
      },
      required: ['minutes'],
    },
    run: (input) => macos.timerSet(input),
    summarise: (i) => `set a ${i.minutes} minute timer${i.label ? ` for ${i.label}` : ''}`,
  },
  {
    name: 'timer_list',
    description: 'Timers currently running and how long is left on each.',
    input_schema: { type: 'object', properties: {} },
    run: () => macos.timerList(),
    summarise: () => 'check running timers',
  },
  {
    name: 'timer_cancel',
    description: 'Cancel a running timer by the id that timer_set or timer_list returned.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Timer id.' } },
      required: ['id'],
    },
    run: (input) => macos.timerCancel(input),
    summarise: (i) => `cancel timer ${i.id}`,
  },
  {
    name: 'files_search',
    description:
      "Find files on this Mac by name or contents, using Spotlight. Use it when the user refers to a document they cannot place — \"my thesis draft\", \"that invoice\".",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for in the name or contents.' },
        limit: { type: 'integer', description: 'Maximum results, default 10.' },
      },
      required: ['query'],
    },
    run: (input) => macos.filesSearch(input),
    summarise: (i) => `search this Mac for “${i.query}”`,
  },
  {
    name: 'open_item',
    description:
      'Open a file, folder, application or web link on this Mac. Use a path from files_search, an app name, or an http(s) address.',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'A file path, application name, or http(s) URL.' } },
      required: ['target'],
    },
    run: (input) => macos.openItem(input),
    summarise: (i) => `open ${i.target}`,
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function permissionFor(name) {
  return load().permissions?.[name] || 'ask';
}

/** Schemas for every tool the model is allowed to see. */
function definitions() {
  return TOOLS.filter((t) => permissionFor(t.name) !== 'deny').map(({ name, description, input_schema }) => ({
    name,
    description,
    input_schema,
  }));
}

function describeCall(name, input) {
  const tool = BY_NAME.get(name);
  if (!tool) return name;
  try {
    return tool.summarise(input || {});
  } catch {
    return name;
  }
}

/**
 * Run a tool after checking permission.
 * `requestApproval(name, input, summary)` must resolve truthy to proceed.
 */
async function execute(name, input, { requestApproval } = {}) {
  const tool = BY_NAME.get(name);
  if (!tool) return { error: `There is no tool called "${name}".` };

  const permission = permissionFor(name);
  if (permission === 'deny') {
    return { error: `The user has not granted permission to use ${name}.` };
  }
  if (permission === 'ask') {
    const ok = requestApproval ? await requestApproval(name, input, describeCall(name, input)) : false;
    if (!ok) {
      return { error: `The user declined permission to ${describeCall(name, input)}. Continue without it.` };
    }
  }

  try {
    return await tool.run(input || {});
  } catch (err) {
    // Tool failure is information for the model, not a crash.
    return { error: err.message };
  }
}

module.exports = { TOOLS, definitions, execute, describeCall, permissionFor };
