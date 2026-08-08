'use strict';
/**
 * Regression tests for the Ollama request shaping.
 *
 * The Settings menu stores every dropdown choice as a string. Ollama accepts
 * keep_alive as a JSON number (seconds; -1 never unloads, 0 unloads at once) or
 * as a duration string carrying a unit ("30s"). A bare numeric *string* is
 * neither, and Ollama rejects the whole request with
 *   400 time: missing unit in duration "-1"
 * which took the app out entirely — every message failed until the setting was
 * changed back.
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// config.js reaches for Electron; stub it before requiring the provider.
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: { getPath: () => '/tmp/verity-test-cfg', getAppPath: () => process.cwd() },
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return originalLoad.call(this, request, ...rest);
};

const { keepAliveValue } = require('../src/main/providers/ollama');

test('numeric keep_alive strings become JSON numbers', () => {
  // These are the two that broke: sent as strings they have no unit.
  assert.strictEqual(keepAliveValue('-1'), -1);
  assert.strictEqual(keepAliveValue('0'), 0);
  assert.strictEqual(keepAliveValue('300'), 300);
  for (const v of [keepAliveValue('-1'), keepAliveValue('0')]) {
    assert.strictEqual(typeof v, 'number');
  }
});

test('duration strings are passed through untouched', () => {
  assert.strictEqual(keepAliveValue('30s'), '30s');
  assert.strictEqual(keepAliveValue('2m'), '2m');
  assert.strictEqual(keepAliveValue('5m'), '5m');
  assert.strictEqual(keepAliveValue('1h30m'), '1h30m');
});

test('numbers are left alone', () => {
  assert.strictEqual(keepAliveValue(-1), -1);
  assert.strictEqual(keepAliveValue(0), 0);
});

test('missing or empty values fall back to a valid duration', () => {
  for (const empty of [undefined, null, '']) {
    const v = keepAliveValue(empty);
    assert.strictEqual(v, '5m');
  }
});

test('every option the Settings dropdown can produce is valid for Ollama', () => {
  // Mirrors the <option value> list in src/renderer/index.html.
  for (const option of ['0', '30s', '2m', '5m', '-1']) {
    const v = keepAliveValue(option);
    const ok = typeof v === 'number' || /^(\d+(ns|us|ms|s|m|h))+$/.test(v);
    assert.ok(ok, `keep_alive ${JSON.stringify(option)} produced invalid value ${JSON.stringify(v)}`);
  }
});
