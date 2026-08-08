'use strict';
/**
 * Tests for the web tools' safety boundaries.
 *
 * These are offline and deterministic — no network. What matters here is not
 * that search works (that depends on a third party) but that the app cannot be
 * talked into fetching something on this machine or the local network, and that
 * a refusal is never reported as a connection problem.
 */

const test = require('node:test');
const assert = require('node:assert');

const { isPrivateAddress, assertPublicHost, pageToText } = require('../src/main/tools/web');

test('loopback, private and link-local addresses are recognised', () => {
  const private_ = [
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.5', '10.255.255.255',
    '172.16.0.1', '172.20.10.1', '172.31.255.255',
    '192.168.0.1', '192.168.1.1',
    '169.254.169.254', // cloud metadata, the classic SSRF target
    '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback must not slip through
    '::ffff:10.0.0.1',
  ];
  for (const ip of private_) {
    assert.strictEqual(isPrivateAddress(ip), true, `${ip} should be treated as private`);
  }
});

test('ordinary public addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700::1111']) {
    assert.strictEqual(isPrivateAddress(ip), false, `${ip} should be treated as public`);
  }
});

test('boundaries of the 172.16/12 private range are exact', () => {
  assert.strictEqual(isPrivateAddress('172.15.255.255'), false);
  assert.strictEqual(isPrivateAddress('172.16.0.0'), true);
  assert.strictEqual(isPrivateAddress('172.31.255.255'), true);
  assert.strictEqual(isPrivateAddress('172.32.0.0'), false);
});

test('local hostnames are refused without a DNS lookup', async () => {
  for (const host of ['localhost', 'LOCALHOST', 'printer.local', 'db.internal']) {
    await assert.rejects(() => assertPublicHost(host), /local network/i, `${host} should be refused`);
  }
});

test('a literal private IP is refused', async () => {
  await assert.rejects(() => assertPublicHost('127.0.0.1'), /local network/i);
  await assert.rejects(() => assertPublicHost('169.254.169.254'), /local network/i);
});

test('refusals are flagged, so they are not mistaken for being offline', async () => {
  // The message mentions "the local network"; the offline check used to match on
  // the word "network" and report a blocked address as a connection failure.
  await assert.rejects(
    () => assertPublicHost('127.0.0.1'),
    (err) => err.blocked === true
  );
});

test('pageToText strips scripts, furniture and tags', () => {
  const html = `
    <html><head><style>a{color:red}</style></head>
    <body>
      <nav>Home About Contact</nav>
      <script>steal()</script>
      <h1>Headline</h1>
      <p>The first real paragraph of the article, long enough to be kept by the filter.</p>
      <footer>Copyright notice</footer>
    </body></html>`;
  const text = pageToText(html, 4000);
  assert.ok(!text.includes('steal'), 'script contents must go');
  assert.ok(!text.includes('color:red'), 'style contents must go');
  assert.ok(!text.includes('Home About Contact'), 'nav must go');
  assert.ok(!text.includes('Copyright notice'), 'footer must go');
  assert.ok(text.includes('# Headline'));
  assert.ok(text.includes('first real paragraph'));
  assert.ok(!/<[a-z]/i.test(text), 'no tags should survive');
});

test('pageToText truncates long pages and says so', () => {
  const text = pageToText(`<p>${'sentence here. '.repeat(3000)}</p>`, 600);
  assert.ok(text.length < 900);
  assert.ok(text.includes('truncated'));
});
