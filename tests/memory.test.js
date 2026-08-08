'use strict';
/**
 * Tests for conversation titling and the brief's schedule parsing.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: { getPath: () => path.join(os.tmpdir(), 'verity-memory-test'), getAppPath: () => process.cwd() },
      safeStorage: { isEncryptionAvailable: () => false },
      Notification: class {
        show() {}
      },
      clipboard: { readText: () => '', writeText: () => {} },
    };
  }
  return originalLoad.call(this, request, ...rest);
};

const memory = require('../src/main/memory');
const brief = require('../src/main/brief');

test('conversation titles strip stacked openers including the wake word', () => {
  // "Hey Verity, …" has two openers; stripping once leaves the wake word at the
  // front of every single title.
  assert.strictEqual(memory.titleFrom('Hey Verity, what is on my calendar today?'), 'What is on my calendar today');
  assert.strictEqual(memory.titleFrom('Verity remind me to buy milk'), 'Remind me to buy milk');
  assert.strictEqual(memory.titleFrom('okay so could you find my thesis'), 'Find my thesis');
});

test('conversation titles drop trailing punctuation', () => {
  // Otherwise the filename sanitiser turns "?" into "-" and every question ends
  // in a dash.
  for (const q of ['What is photosynthesis?', 'What is photosynthesis!', 'What is photosynthesis...']) {
    assert.strictEqual(memory.titleFrom(q), 'What is photosynthesis');
  }
});

test('conversation titles never contain characters illegal in a filename', () => {
  const title = memory.titleFrom('what about a/b testing: is it worth it?');
  assert.ok(!/[\\/:*?"<>|]/.test(title), `illegal character survived in ${JSON.stringify(title)}`);
});

test('an empty or useless opening message still gets a title', () => {
  for (const input of ['', '   ', 'hey', 'okay so']) {
    assert.strictEqual(memory.titleFrom(input), 'Conversation');
  }
});

test('long openings are truncated rather than becoming huge filenames', () => {
  const title = memory.titleFrom('tell me everything you know about the history of computing from the abacus onwards please');
  assert.ok(title.length <= 60, `title too long: ${title.length}`);
});

test('brief schedule accepts valid times and rejects the rest', () => {
  assert.deepStrictEqual(brief.parseTime('08:00'), { hours: 8, minutes: 0 });
  assert.deepStrictEqual(brief.parseTime('7:30'), { hours: 7, minutes: 30 });
  assert.deepStrictEqual(brief.parseTime('23:59'), { hours: 23, minutes: 59 });
  for (const bad of ['25:00', '08:60', 'abc', '', '8', '08:0', null, undefined]) {
    assert.strictEqual(brief.parseTime(bad), null, `${JSON.stringify(bad)} should be rejected`);
  }
});

test('the brief falls back to plain facts when the model is unavailable', () => {
  const text = brief.fallbackText({
    events: [{ title: 'Dentist', startsAt: '10:00' }],
    reminders: [{ title: 'Buy milk' }],
    weather: { location: 'Edinburgh', current: { temperature: '14°C', conditions: 'light rain' } },
  });
  assert.ok(text.includes('Edinburgh'));
  assert.ok(text.includes('Dentist'));
  assert.ok(text.includes('Buy milk'));
});

test('the brief says the calendar is clear rather than nothing at all', () => {
  const text = brief.fallbackText({ events: [], reminders: [], weather: null });
  assert.ok(/clear/i.test(text), `expected a statement, got: ${text}`);
});
