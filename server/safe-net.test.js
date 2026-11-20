import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns';
import { isBlockedIp, isBlockedName, assertPublicHost, guardedLookup, safeRequest, readText, BlockedError } from './safe-net.js';

test('isBlockedIp blocks private, loopback, link-local, CGNAT, mapped and reserved ranges', () => {
  for (const ip of [
    '127.0.0.1', '127.255.255.254', '0.0.0.0', '0.1.2.3', '10.1.2.3', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '64:ff9b::7f00:1', '2002:7f00:1::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '[::1]', 'fe80::1%eth0',
    'not-an-ip', '', undefined,
  ]) assert.equal(isBlockedIp(ip), true, String(ip));
});

test('isBlockedIp allows ordinary public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])
    assert.equal(isBlockedIp(ip), false, ip);
});

test('isBlockedName blocks local-only names', () => {
  for (const n of ['localhost', 'a.localhost', 'printer.local', 'metadata.google.internal', '', 'LOCALHOST.']) assert.equal(isBlockedName(n), true, n);
  assert.equal(isBlockedName('example.com'), false);
});

test('assertPublicHost rejects literals and names that resolve to blocked addresses', async () => {
  await assert.rejects(assertPublicHost('127.0.0.1'), BlockedError);
  await assert.rejects(assertPublicHost('[::1]'), BlockedError);
  await assert.rejects(assertPublicHost('localhost'), BlockedError);
  await assert.doesNotReject(assertPublicHost('8.8.8.8'));
});

test('guardedLookup rejects when ANY answer is blocked and passes through when allowed', async () => {
  const blockedAll = guardedLookup(() => true);
  await assert.rejects(new Promise((res, rej) => blockedAll('localhost', {}, (e, a) => e ? rej(e) : res(a))), /not allowed/);
  const allowAll = guardedLookup(() => false);
  const ok = await new Promise((res, rej) => allowAll('localhost', { all: true }, (e, a) => e ? rej(e) : res(a)));
  assert.ok(ok.length >= 1);
  const single = await new Promise((res, rej) => allowAll('localhost', {}, (e, addr, fam) => e ? rej(e) : res({ addr, fam })));
  assert.ok(single.addr);
});

function listen(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('safeRequest refuses loopback by default (no connection is made)', async () => {
  let hit = false;
  const { server, port } = await listen((req, res) => { hit = true; res.end('secret'); });
  try {
    await assert.rejects(safeRequest(`http://127.0.0.1:${port}/`), BlockedError);
    await assert.rejects(safeRequest(`http://localhost:${port}/`), BlockedError);
    await assert.rejects(safeRequest(`http://[::1]:${port}/`), BlockedError);
    await assert.rejects(safeRequest('file:///etc/passwd'), BlockedError);
    await assert.rejects(safeRequest(`http://user:pw@8.8.8.8/`), BlockedError);
    assert.equal(hit, false);
  } finally { server.close(); }
});

test('safeRequest follows redirects and revalidates every hop', async () => {
  const { server, port } = await listen((req, res) => {
    if (req.url === '/a') { res.writeHead(302, { location: '/b' }); return res.end(); }
    if (req.url === '/b') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('final'); }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
    if (req.url === '/evil') { res.writeHead(302, { location: `http://127.0.0.2:${port}/b` }); return res.end(); }
    res.statusCode = 404; res.end();
  });
  // Allow only 127.0.0.1 so a redirect to 127.0.0.2 stands in for "redirect to an internal host".
  const checkAddress = ip => ip !== '127.0.0.1';
  try {
    const ok = await safeRequest(`http://127.0.0.1:${port}/a`, { checkAddress });
    assert.equal(ok.status, 200);
    assert.equal(ok.url, `http://127.0.0.1:${port}/b`);
    assert.equal(await readText(ok.stream), 'final');
    await assert.rejects(safeRequest(`http://127.0.0.1:${port}/loop`, { checkAddress, maxRedirects: 3 }), /Too many redirects/);
    await assert.rejects(safeRequest(`http://127.0.0.1:${port}/evil`, { checkAddress }), BlockedError);
  } finally { server.close(); }
});

test('safeRequest blocks a public-looking hostname whose DNS answer is internal (rebinding guard)', async () => {
  let hit = false;
  const { server, port } = await listen((req, res) => { hit = true; res.end('internal'); });
  const realLookup = dns.lookup;
  // The attacker's DNS server answers with loopback at connect time.
  dns.lookup = (host, options, cb) => (typeof options === 'function' ? options : cb)(null, [{ address: '127.0.0.1', family: 4 }]);
  try {
    await assert.rejects(safeRequest(`http://rebind.example:${port}/`), err => err instanceof BlockedError || err.code === 'EBLOCKED');
    assert.equal(hit, false, 'no connection may be opened to the internal address');
    // Same stub, but a checker that allows 127.0.0.1: proves the guarded lookup is what the socket really uses.
    const up = await safeRequest(`http://rebind.example:${port}/`, { checkAddress: ip => ip !== '127.0.0.1' });
    assert.equal(await readText(up.stream), 'internal');
    assert.equal(hit, true);
  } finally { dns.lookup = realLookup; server.close(); }
});

test('readText stops reading after the limit', async () => {
  const { server, port } = await listen((req, res) => { res.write('a'.repeat(5000)); setTimeout(() => res.end('b'.repeat(5000)), 50); });
  try {
    const up = await safeRequest(`http://127.0.0.1:${port}/`, { checkAddress: () => false });
    const text = await readText(up.stream, 1000);
    assert.equal(text.length, 1000);
  } finally { server.close(); }
});
