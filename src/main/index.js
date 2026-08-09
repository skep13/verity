'use strict';
/**
 * Verity — main process.
 *
 * Holds everything privileged: model calls, the filesystem, tool execution and
 * speech. The renderer gets a narrow, explicit API through the preload bridge
 * and has no direct Node access.
 */

const fs = require('fs');
const path = require('path');
const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  session,
  globalShortcut,
  systemPreferences,
  nativeTheme,
  Notification,
} = require('electron');

const config = require('./config');
const agent = require('./agent');
const toolRegistry = require('./tools');
const ollama = require('./providers/ollama');
const claude = require('./providers/claude');
const wikipedia = require('./tools/wikipedia');
const obsidian = require('./tools/obsidian');
const macos = require('./tools/macos');
const vault = require('./vault');
const memory = require('./memory');
const personas = require('./personas');
const brief = require('./brief');
const stt = require('./speech/stt');
const tts = require('./speech/tts');
const voicevox = require('./speech/voicevox');

let mainWindow = null;
let currentTurn = null; // AbortController for the in-flight reply
const pendingApprovals = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 760,
    minWidth: 420,
    minHeight: 560,
    show: false,
    title: 'Verity',
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Surface renderer errors on the terminal. Without this a broken UI just sits
  // there looking inert, with the stack trace buried in devtools.
  mainWindow.webContents.on('console-message', (...args) => {
    const first = args[0];
    const d =
      first && typeof first === 'object' && 'message' in first
        ? first
        : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
    const isError = d.level === 'error' || d.level === 3;
    if (isError || process.argv.includes('--dev')) {
      console.log(`[renderer:${d.level}] ${d.message}  (${d.sourceId}:${d.lineNumber})`);
    }
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, description) => {
    console.error(`[renderer] failed to load: ${description} (${code})`);
  });

  // Links open in the real browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Grant media only to our own renderer; deny everything else outright. */
function lockDownPermissions() {
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === 'media' || permission === 'audioCapture');
  });
}

function toggleWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else {
    mainWindow.show();
    mainWindow.focus();
  }
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = config.load().ui.theme === 'light' ? 'light' : 'dark';
  lockDownPermissions();

  createWindow();

  // Prompt for the microphone up front so the first voice attempt is not the
  // one that hits a permission wall.
  try {
    await systemPreferences.askForMediaAccess('microphone');
  } catch {
    /* the renderer will surface the failure if it matters */
  }

  // Catch up on anything edited in Obsidian while Verity was closed. Delayed so
  // it never competes with the window appearing, and failures are ignored:
  // search falls back to keyword matching if the index is stale or missing.
  vault.scheduleReindex(8000);

  // Summon from anywhere — this is the "easy to open" part.
  globalShortcut.register('CommandOrControl+Shift+V', toggleWindow);

  brief.start({
    onBrief: ({ text }) => {
      new Notification({ title: 'Verity — your brief', body: text.slice(0, 220), sound: 'Glass' }).show();
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.show();
        mainWindow.webContents.send('brief:ready', { text });
      }
    },
  });

  // An elapsed timer should reach you even if Verity is behind another window,
  // so it both notifies and says so out loud.
  macos.setTimerHandler(({ label }) => {
    new Notification({ title: 'Verity', body: `${label} — time is up.`, sound: 'Glass' }).show();
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('timer:elapsed', { label });
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  wikipedia.closeAll();
});

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/**
 * The vault is resolved lazily on every read rather than pinned at startup: a
 * configured path that has since been moved or deleted falls back to discovery,
 * so the tools keep working. Settings shows the path actually in use.
 */
function resolvedVaultPath() {
  try {
    return obsidian.vaultRoot();
  } catch {
    return '';
  }
}

ipcMain.handle('config:get', () => ({
  ...config.load(),
  resolvedVaultPath: resolvedVaultPath(),
  hasClaudeKey: config.hasClaudeKey(),
}));

ipcMain.handle('config:set', (_e, patch) => {
  const next = config.save(patch);
  if (patch.ui?.theme) nativeTheme.themeSource = patch.ui.theme === 'light' ? 'light' : 'dark';
  return { ...next, hasClaudeKey: config.hasClaudeKey() };
});

ipcMain.handle('config:setClaudeKey', (_e, key) => {
  config.setClaudeKey(key);
  return { hasClaudeKey: config.hasClaudeKey() };
});

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

ipcMain.handle('models:list', async () => {
  const out = { ollama: [], claude: [], ollamaRunning: false, error: null };
  try {
    out.ollamaRunning = await ollama.isRunning();
    if (out.ollamaRunning) out.ollama = await ollama.listModels();
    else out.error = 'Ollama is not running. Start it with: ollama serve';
  } catch (err) {
    out.error = err.message;
  }
  if (config.hasClaudeKey()) out.claude = claude.listModels();
  return out;
});

/* ------------------------------------------------------------------ */
/* Conversation                                                        */
/* ------------------------------------------------------------------ */

/**
 * Ask the renderer to approve a tool call and wait for the answer.
 * Resolves false if the window disappears, so a closed window cannot leave a
 * tool call hanging forever.
 */
function requestApproval(name, input, summary) {
  return new Promise((resolve) => {
    if (!mainWindow) {
      resolve(false);
      return;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingApprovals.set(id, resolve);
    mainWindow.webContents.send('tool:approval-request', { id, name, input, summary });
  });
}

ipcMain.on('tool:approval-response', (_e, { id, approved, remember }) => {
  const resolve = pendingApprovals.get(id);
  if (!resolve) return;
  pendingApprovals.delete(id);
  if (remember && approved) {
    const name = remember;
    config.save({ permissions: { [name]: 'allow' } });
  }
  resolve(Boolean(approved));
});

ipcMain.handle('chat:send', async (event, { message, history, spoken }) => {
  currentTurn = new AbortController();
  const send = (channel, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
  };

  try {
    const result = await agent.run({
      history: history || [],
      userMessage: message,
      spoken: Boolean(spoken),
      signal: currentTurn.signal,
      onToken: (t) => send('chat:token', t),
      onToolStart: (info) => send('tool:start', info),
      onToolEnd: (info) => send('tool:end', { ...info, output: summariseOutput(info.output) }),
      requestApproval,
    });

    // Write the exchange to the vault so it outlives this window.
    memory.recordTurn({ user: message, assistant: result.text, toolsUsed: result.toolsUsed });

    return { ok: true, ...result };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, aborted: true };
    return { ok: false, error: err.message };
  } finally {
    currentTurn = null;
  }
});

/** Tool output can be large; the UI only needs a gist of what happened. */
function summariseOutput(output) {
  if (!output || typeof output !== 'object') return output;
  if (output.error) return { error: output.error };
  if (output.available === false) return { error: output.error || 'unavailable' };
  if (Array.isArray(output.results)) return { count: output.results.length };
  if (output.title) return { title: output.title };
  if (output.path) return { path: output.path, action: output.action };
  return { ok: true };
}

ipcMain.handle('chat:abort', () => {
  currentTurn?.abort();
  return true;
});

// "New conversation" starts a new note rather than appending to the old one.
ipcMain.handle('chat:new', () => {
  memory.end();
  return true;
});

/* ------------------------------------------------------------------ */
/* Speech                                                              */
/* ------------------------------------------------------------------ */

ipcMain.handle('stt:transcribe', async (_e, { pcm, sampleRate }) => {
  try {
    const text = await stt.transcribe(Buffer.from(pcm), sampleRate || 16000);
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('stt:available', () => stt.available());

ipcMain.handle('tts:voices', () => tts.listVoices());

/**
 * Synthesise and hand back the audio bytes. Returning the data rather than a
 * path keeps the renderer out of the filesystem entirely.
 */
ipcMain.handle('tts:speak', async (_e, { text, voice, rate }) => {
  try {
    // Resolve voice and pitch here rather than in the renderer: the persona and
    // language live in config, and the renderer should not have to know how they
    // combine. An explicit voice from Settings still wins.
    const cfg = config.load();
    const language = cfg.language || 'en';
    const preset = personas.speechFor(cfg.persona, language);
    const speakingRate = rate || cfg.voice.rate;

    // VOICEVOX speaks Japanese only, and badly mangles English, so it is used
    // only when the language is Japanese and the local engine is actually up.
    // Anything else falls through to the macOS voices.
    if (cfg.voicevoxEnabled && language === 'ja' && (await voicevox.isRunning())) {
      try {
        const wav = await voicevox.synthesise({
          text: tts.speakable(text),
          speaker: cfg.voicevoxSpeaker,
          rate: speakingRate,
          pitch: preset.pitch,
        });
        if (wav) {
          return { ok: true, audio: wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) };
        }
      } catch (err) {
        // A failed engine must not mean silence; fall through to `say`.
        console.log(`[voicevox] ${err.message} — falling back to the system voice`);
      }
    }

    const file = await tts.synthesise({
      text,
      voice: voice || cfg.voice.name || preset.voice,
      rate: speakingRate,
      pitch: preset.pitch,
    });
    if (!file) return { ok: true, empty: true };
    const audio = fs.readFileSync(file);
    fs.unlink(file, () => {});
    return { ok: true, audio: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('voicevox:status', async () => ({
  running: await voicevox.isRunning(),
  version: await voicevox.version(),
  voices: await voicevox.listVoices(),
  host: config.load().voicevoxHost,
  termsUrl: voicevox.TERMS_URL,
}));

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

// Full persona definitions, so the renderer can theme itself without a second
// copy of the palette living in the CSS.
ipcMain.handle('personas:list', () => {
  const cfg = config.load();
  return {
    current: cfg.persona || 'verity',
    language: cfg.language || 'en',
    personas: Object.values(personas.PERSONAS),
  };
});

ipcMain.handle('status:all', async () => ({
  wikipedia: wikipedia.status(),
  obsidian: obsidian.status(),
  whisper: stt.languageSupported(),
  language: config.load().language || 'en',
  ollama: await ollama.isRunning(),
  online: await isOnline(),
}));

ipcMain.handle('tools:list', () => {
  const permissions = config.load().permissions;
  return toolRegistry.TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    permission: permissions[t.name] || 'ask',
  }));
});

/** A cheap reachability check used only to label the UI. */
async function isOnline() {
  try {
    const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current=temperature_2m', {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Run the brief now, for testing the settings without waiting until morning.
ipcMain.handle('brief:run', async () => {
  try {
    const result = await brief.run({});
    return { ok: true, text: result.text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app:setLoginItem', (_e, enabled) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true });
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('app:getLoginItem', () => app.getLoginItemSettings().openAtLogin);

ipcMain.handle('vault:reveal', () => {
  try {
    shell.openPath(obsidian.vaultRoot());
    return true;
  } catch {
    return false;
  }
});
