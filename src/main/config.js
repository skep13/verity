'use strict';
/**
 * Settings persistence.
 *
 * Everything except the Claude API key lives in a plain JSON file under the app's
 * userData directory. The API key goes through Electron's safeStorage, which is
 * backed by the macOS Keychain — it is never written in the clear and never
 * crosses into the renderer.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
  provider: 'ollama',
  // qwen2.5:1.5b was the default until the tool surface reached 16, at which
  // point it started answering "I don't have access to your calendar" instead of
  // calling the tool it had — 2/5 on that prompt against 5/5 for 3b. Falsely
  // denying access is worse than being a few seconds slower, so 3b it is.
  // Reasoning models (qwen3, r1) bake chain of thought into the reply on Ollama:
  // slow, and unbearable read aloud. Any installed model can be picked in Settings.
  model: 'qwen2.5:3b',
  ollamaHost: 'http://127.0.0.1:11434',
  claudeModel: 'claude-sonnet-5',

  // Voice and typing can run on different local models. A smaller one answers
  // fast enough for speech to feel like conversation, while typed questions go
  // to something more careful. Empty means voice uses the same model as typing.
  voiceModel: '',

  // The two knobs that decide how much RAM is left for everything else.
  // keepAlive: how long Ollama holds the model in memory after a reply.
  // numCtx: context window, which sets the KV cache size.
  ollamaKeepAlive: '2m',
  numCtx: 8192,

  voice: {
    enabled: true,
    name: 'Samantha',
    rate: 190,
    speakReplies: true,
  },

  stt: {
    model: 'ggml-base.en.bin',
    // Whisper on an M2 is fast enough to leave threads modest and keep the UI smooth.
    threads: 4,
  },

  // Left empty on purpose: the vault is discovered on first run and written back
  // here, so a moved vault is found rather than guessed at.
  vaultPath: '',
  vaultFolder: 'Verity',
  // Loaded into every system prompt, so core facts never depend on the model
  // choosing to search for them.
  profileNote: 'Profile',

  // Conversations are appended to dated notes here, so they survive quitting and
  // become searchable alongside everything else in the vault.
  chatsFolder: 'chats',
  saveConversations: true,

  brief: {
    enabled: false,
    // 24-hour local time.
    time: '08:00',
    days: 1,
    location: '',
  },

  // Speak the wake word and Verity starts listening without a keypress. Only
  // utterances the voice detector already picked out are transcribed, so this
  // costs nothing while the room is quiet.
  wakeWord: {
    enabled: false,
    phrase: 'verity',
  },

  // Per-tool permission. 'allow' runs silently, 'ask' prompts each call,
  // 'deny' hides the tool from the model entirely.
  permissions: {
    obsidian_search: 'allow',
    obsidian_read: 'allow',
    obsidian_write: 'ask',
    obsidian_list: 'allow',
    wikipedia_search: 'allow',
    wikipedia_read: 'allow',
    weather: 'ask',
    datetime: 'allow',

    // Reading is cheap and reversible; anything that writes to the user's
    // calendar, their reminders, or launches something asks first.
    calendar_list: 'allow',
    calendar_add: 'ask',
    reminder_add: 'ask',
    reminders_list: 'allow',
    // The clipboard holds passwords and card numbers seconds after they are
    // copied, so reading it is always a conscious decision.
    clipboard_read: 'ask',
    clipboard_write: 'ask',
    timer_set: 'allow',
    timer_list: 'allow',
    timer_cancel: 'allow',
    files_search: 'allow',
    open_item: 'ask',

    // The only tools that send anything off this Mac, so they ask by default.
    // Tick "always allow" in the prompt if you would rather they just run.
    web_search: 'ask',
    web_fetch: 'ask',
  },

  zim: {
    // Directories scanned for .zim files. /Volumes covers any mounted USB stick.
    searchPaths: ['/Volumes', path.join(os.homedir(), 'Documents'), path.join(os.homedir(), 'Downloads')],
    preferredPath: null,
  },

  // Where you are, as a place name. Used whenever weather is asked for without
  // one, and by the morning brief. A single setting rather than one per feature.
  homeLocation: '',

  location: {
    // Optional exact coordinates, which take precedence over homeLocation.
    latitude: null,
    longitude: null,
    label: null,
  },

  // Changes the name, palette, voice pitch and tone. Never the honesty rules.
  persona: 'verity',

  // Which language to listen in and reply in. Switching this changes the speech
  // recognition model as well: the English-only whisper model cannot transcribe
  // Japanese, and would return confident nonsense rather than failing.
  language: 'en',

  ui: {
    theme: 'dark',
    autoSpeak: true,
    // Start listening the moment the window opens, so summoning Verity with the
    // hotkey and talking is one motion.
    autoListen: false,
  },
};

let cache = null;

function configPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

/** One encrypted file per named secret, all under userData. */
function keyPath(name = 'claude') {
  return path.join(app.getPath('userData'), `${name}-key.bin`);
}

/** Recursive merge so new defaults appear for users with an existing settings file. */
function merge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = merge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function load() {
  if (cache) return cache;
  try {
    cache = merge(DEFAULTS, JSON.parse(fs.readFileSync(configPath(), 'utf8')));
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(patch) {
  cache = merge(load(), patch);
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cache, null, 2));
  return cache;
}

function setSecret(name, value) {
  if (!value) {
    try {
      fs.unlinkSync(keyPath(name));
    } catch {
      /* already absent */
    }
    return true;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Keychain encryption is unavailable, so the API key cannot be stored securely.');
  }
  fs.mkdirSync(path.dirname(keyPath(name)), { recursive: true });
  fs.writeFileSync(keyPath(name), safeStorage.encryptString(value), { mode: 0o600 });
  return true;
}

function getSecret(name) {
  try {
    return safeStorage.decryptString(fs.readFileSync(keyPath(name)));
  } catch {
    return null;
  }
}

function hasSecret(name) {
  return fs.existsSync(keyPath(name));
}

const setClaudeKey = (key) => setSecret('claude', key);
const getClaudeKey = () => getSecret('claude');
const hasClaudeKey = () => hasSecret('claude');

module.exports = { load, save, setClaudeKey, getClaudeKey, hasClaudeKey, DEFAULTS };
