'use strict';
/**
 * Tests for vault indexing and discovery.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const USER_DATA = path.join(os.tmpdir(), 'verity-vault-test');
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: { getPath: () => USER_DATA, getAppPath: () => process.cwd() },
      safeStorage: { isEncryptionAvailable: () => false },
      Notification: class {
        show() {}
      },
    };
  }
  return originalLoad.call(this, request, ...rest);
};

const obsidian = require('../src/main/tools/obsidian');
const vault = require('../src/main/vault');
const { tidy, collectFiles } = require('../src/main/vault/import');

test('vault discovery runs without throwing on an unset path', () => {
  // Regression: discoverVault called os.homedir() while `os` was never required,
  // so every vault operation threw ReferenceError once the configured path was
  // empty — which is the normal state, since the path is discovered not stored.
  assert.doesNotThrow(() => obsidian.discoverVault());
  const status = obsidian.status();
  assert.strictEqual(typeof status.available, 'boolean');
  if (!status.available) {
    assert.ok(!/is not defined/.test(status.error), `discovery crashed rather than failing cleanly: ${status.error}`);
  }
});

test('notes are chunked on paragraph boundaries and keep their title', () => {
  const chunks = vault.chunkNote('Thesis', `Due on the 12th of September.\n\n${'Filler about methodology. '.repeat(60)}\n\nSupervisor is Dr Wong.`);
  assert.ok(chunks.length > 1, 'a long note should produce several passages');
  assert.ok(chunks.every((c) => c.startsWith('Thesis')), 'every passage must say which note it came from');
  assert.ok(chunks.some((c) => c.includes('12th of September')));
  assert.ok(chunks.some((c) => c.includes('Dr Wong')));
});

test('frontmatter is excluded from chunks', () => {
  const chunks = vault.chunkNote('Note', '---\ntitle: Note\ntags: [x]\n---\n\nThe actual content of the note goes here and is long enough to keep.');
  assert.ok(chunks.length >= 1);
  assert.ok(!chunks.join(' ').includes('tags:'), 'frontmatter should not be embedded');
  assert.ok(chunks[0].includes('actual content'));
});

test('a short note still produces one passage', () => {
  const chunks = vault.chunkNote('Small', 'My thesis is due on the twelfth.');
  assert.strictEqual(chunks.length, 1);
  assert.ok(chunks[0].includes('twelfth'));
});

test('an empty note produces nothing', () => {
  assert.deepStrictEqual(vault.chunkNote('Empty', '   \n\n  '), []);
  assert.deepStrictEqual(vault.chunkNote('OnlyFrontmatter', '---\ntitle: x\n---\n'), []);
});

test('vectors survive packing to base64 and back', () => {
  const original = Array.from({ length: 768 }, (_, i) => Math.sin(i) * 0.5);
  const restored = vault.unpackVector(vault.packVector(original));
  assert.strictEqual(restored.length, 768);
  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs(restored[i] - original[i]) < 1e-6, `element ${i} drifted`);
  }
});

test('cosine similarity behaves', () => {
  const a = Float32Array.from([1, 0, 0]);
  const b = Float32Array.from([1, 0, 0]);
  const c = Float32Array.from([0, 1, 0]);
  const d = Float32Array.from([-1, 0, 0]);
  assert.ok(Math.abs(vault.cosine(a, b) - 1) < 1e-6, 'identical vectors score 1');
  assert.ok(Math.abs(vault.cosine(a, c)) < 1e-6, 'orthogonal vectors score 0');
  assert.ok(Math.abs(vault.cosine(a, d) + 1) < 1e-6, 'opposite vectors score -1');
  assert.strictEqual(vault.cosine(Float32Array.from([0, 0, 0]), a), 0, 'a zero vector must not divide by zero');
});

test('import tidies the whitespace textutil leaves behind', () => {
  assert.strictEqual(tidy('a\r\n\r\n\r\n\r\nb   \n'), 'a\n\nb');
});

test('import collects supported files and skips noise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-import-'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'page.html'), '<p>hi</p>');
  fs.writeFileSync(path.join(dir, 'photo.jpg'), 'binary');
  fs.writeFileSync(path.join(dir, '.hidden.txt'), 'secret');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep.txt'), 'nope');

  const found = collectFiles(dir).map((f) => path.basename(f)).sort();
  assert.deepStrictEqual(found, ['notes.txt', 'page.html'].sort());

  fs.rmSync(dir, { recursive: true, force: true });
});
