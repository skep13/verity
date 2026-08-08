'use strict';
/**
 * The only bridge between the renderer and anything privileged.
 * Every entry here is an explicit, named capability — the renderer never sees
 * ipcRenderer, require, or the filesystem.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** Wrap a main->renderer push channel so listeners cannot leak the raw event. */
function on(channel, handler) {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('verity', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch),
    setClaudeKey: (key) => ipcRenderer.invoke('config:setClaudeKey', key),
  },

  models: {
    list: () => ipcRenderer.invoke('models:list'),
  },

  chat: {
    send: (payload) => ipcRenderer.invoke('chat:send', payload),
    abort: () => ipcRenderer.invoke('chat:abort'),
    new: () => ipcRenderer.invoke('chat:new'),
    onToken: (fn) => on('chat:token', fn),
    onToolStart: (fn) => on('tool:start', fn),
    onToolEnd: (fn) => on('tool:end', fn),
  },

  tools: {
    list: () => ipcRenderer.invoke('tools:list'),
    onApprovalRequest: (fn) => on('tool:approval-request', fn),
    respond: (payload) => ipcRenderer.send('tool:approval-response', payload),
  },

  speech: {
    // pcm is a transferable ArrayBuffer of 16-bit mono samples.
    transcribe: (pcm, sampleRate) => ipcRenderer.invoke('stt:transcribe', { pcm, sampleRate }),
    available: () => ipcRenderer.invoke('stt:available'),
    voices: () => ipcRenderer.invoke('tts:voices'),
    speak: (text, voice, rate) => ipcRenderer.invoke('tts:speak', { text, voice, rate }),
  },

  status: {
    all: () => ipcRenderer.invoke('status:all'),
  },

  personas: {
    list: () => ipcRenderer.invoke('personas:list'),
  },

  timers: {
    onElapsed: (fn) => on('timer:elapsed', fn),
  },

  brief: {
    run: () => ipcRenderer.invoke('brief:run'),
    onReady: (fn) => on('brief:ready', fn),
  },

  app: {
    getLoginItem: () => ipcRenderer.invoke('app:getLoginItem'),
    setLoginItem: (enabled) => ipcRenderer.invoke('app:setLoginItem', enabled),
  },

  vault: {
    reveal: () => ipcRenderer.invoke('vault:reveal'),
  },
});
