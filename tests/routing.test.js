'use strict';
/**
 * Tests for which model answers a given turn.
 *
 * Verity can use a smaller local model for speech than for typing, so speech
 * stays quick while typed questions go to something more careful. The failure
 * that matters is leakage in either direction: the voice model answering typed
 * questions, or speech quietly waiting on a hosted model.
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: { getPath: () => '/tmp/verity-test-cfg', getAppPath: () => process.cwd() },
      safeStorage: { isEncryptionAvailable: () => false },
      Notification: class {
        show() {}
      },
    };
  }
  return originalLoad.call(this, request, ...rest);
};

const { resolveRoute } = require('../src/main/agent');

const local = { provider: 'ollama', model: 'qwen2.5:3b', voiceModel: 'qwen2.5:1.5b', claudeModel: 'claude-sonnet-5' };

test('a spoken turn uses the voice model when one is set', () => {
  assert.strictEqual(resolveRoute(true, local).model, 'qwen2.5:1.5b');
});

test('a typed turn never uses the voice model', () => {
  // The leak that would matter most: typing silently downgraded to the small model.
  assert.strictEqual(resolveRoute(false, local).model, 'qwen2.5:3b');
});

test('with no voice model set, speech and typing share one model', () => {
  const cfg = { ...local, voiceModel: '' };
  assert.strictEqual(resolveRoute(true, cfg).model, 'qwen2.5:3b');
  assert.strictEqual(resolveRoute(false, cfg).model, 'qwen2.5:3b');
});

test('the voice model is ignored when the provider is hosted', () => {
  // Routing speech to a hosted model would put the network in front of every
  // spoken reply, which defeats the point of a local voice model.
  const cfg = { ...local, provider: 'claude' };
  assert.strictEqual(resolveRoute(true, cfg).name, 'claude');
  assert.strictEqual(resolveRoute(true, cfg).model, 'claude-sonnet-5');
  assert.strictEqual(resolveRoute(false, cfg).model, 'claude-sonnet-5');
});

test('every route returns a usable provider', () => {
  for (const spoken of [true, false]) {
    for (const cfg of [local, { ...local, voiceModel: '' }, { ...local, provider: 'claude' }]) {
      const route = resolveRoute(spoken, cfg);
      assert.ok(route.provider && typeof route.provider.chat === 'function', 'route must expose a chat function');
      assert.ok(route.model, 'route must name a model');
    }
  }
});
