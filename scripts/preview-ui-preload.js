'use strict';
// Stub bridge for previewing the UI without the main process. Mirrors the shape
// of src/preload/index.js so the renderer runs unmodified.
const { contextBridge } = require('electron');

const noop = () => () => {};

contextBridge.exposeInMainWorld('verity', {
  config: {
    get: async () => ({
      provider: 'ollama',
      model: 'qwen2.5:1.5b',
      claudeModel: 'claude-sonnet-5',
      ollamaKeepAlive: '30s',
      numCtx: 8192,
      voice: { name: 'Samantha', rate: 190 },
      vaultPath: '/Users/you/ObsidianVault/AiMemory',
      resolvedVaultPath: '/Users/you/ObsidianVault/AiMemory',
      vaultFolder: 'Verity',
      // PERSONA=miku npx electron scripts/preview-ui.js to preview a persona.
      persona: process.env.PERSONA || 'verity',
      language: process.env.LANGUAGE || 'en',
      ui: { theme: 'dark', autoSpeak: true, autoListen: false },
      voiceModel: '',
      homeLocation: 'Edinburgh',
      saveConversations: true,
      wakeWord: { enabled: false, phrase: 'verity' },
      brief: { enabled: false, time: '08:00', days: 1, location: '' },
      hasClaudeKey: false,
    }),
    set: async (p) => p,
    setClaudeKey: async () => ({}),
  },
  models: {
    list: async () => ({
      ollama: [
        { id: 'qwen2.5:1.5b', label: 'qwen2.5:1.5b', bytes: 986e6 },
        { id: 'qwen2.5:3b', label: 'qwen2.5:3b', bytes: 1.9e9 },
      ],
      claude: [],
      ollamaRunning: true,
    }),
  },
  chat: {
    send: async () => ({ ok: true, text: '' }),
    abort: async () => {},
    new: async () => true,
    onToken: noop,
    onToolStart: noop,
    onToolEnd: noop,
  },
  timers: { onElapsed: noop },
  brief: { run: async () => ({ ok: true, text: 'Your calendar is clear.' }), onReady: noop },
  app: { getLoginItem: async () => false, setLoginItem: async (v) => v },
  personas: {
    list: async () => {
      // Absolute path: a relative require does not resolve from a preload script.
      const personas = require(require('path').join(__dirname, '..', 'src', 'main', 'personas'));
      return {
        current: process.env.PERSONA || 'verity',
        language: process.env.LANGUAGE || 'en',
        personas: Object.values(personas.PERSONAS),
      };
    },
  },
  tools: {
    list: async () => [
      { name: 'obsidian_search', description: '', permission: 'allow' },
      { name: 'obsidian_write', description: '', permission: 'ask' },
      { name: 'wikipedia_search', description: '', permission: 'allow' },
      { name: 'weather', description: '', permission: 'ask' },
    ],
    onApprovalRequest: noop,
    respond: () => {},
  },
  speech: {
    transcribe: async () => ({ ok: true, text: '' }),
    available: async () => true,
    voices: async () => [{ name: 'Samantha', locale: 'en_US', english: true, novelty: false }],
    speak: async () => ({ ok: true, empty: true }),
  },
  status: {
    all: async () => ({
      wikipedia: { available: false, active: null, info: null, archives: [] },
      obsidian: { available: true, path: '/Users/you/ObsidianVault/AiMemory', notes: 3 },
      whisper: true,
      language: process.env.LANGUAGE || 'en',
      ollama: true,
      online: true,
    }),
  },
  vault: { reveal: async () => {} },
});
