import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { safeRequest } from './safe-net.js';
import { sendUpstream, sendText } from './relay.js';

const allow = () => false;
const listen = handler => new Promise(resolve => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});
const wait = ms => new Promise(r => setTimeout(r, ms));

test('sendUpstream passes status and range headers through', async () => {
  const up = await listen((req, res) => {
    res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/10', 'accept-ranges': 'bytes', 'content-length': '4', 'x-secret': 'no' });
    res.end('abcd');
  });
  const front = await listen(async (req, res) => {
    const u = await safeRequest(`http://127.0.0.1:${up.port}/`, { checkAddress: allow, headers: { range: req.headers.range || '' } });
    sendUpstream(res, u);
  });
  try {
    const r = await fetch(`http://127.0.0.1:${front.port}/`, { headers: { range: 'bytes=0-3' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 0-3/10');
    assert.equal(r.headers.get('x-secret'), null);
    assert.equal(await r.text(), 'abcd');
  } finally { up.server.close(); front.server.close(); }
});

test('a viewer that disconnects stops the upstream download', async () => {
  let upstreamClosed = false;
  const up = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4' });
    const timer = setInterval(() => res.write(Buffer.alloc(64 * 1024, 1)), 5);
    res.on('close', () => { upstreamClosed = true; clearInterval(timer); });
  });
  const front = await listen(async (req, res) => {
    sendUpstream(res, await safeRequest(`http://127.0.0.1:${up.port}/`, { checkAddress: allow }));
  });
  try {
    const socket = net.connect(front.port, '127.0.0.1');
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await new Promise(r => socket.once('data', r));
    socket.destroy(); // viewer leaves mid-stream
    for (let i = 0; i < 40 && !upstreamClosed; i++) await wait(50);
    assert.equal(upstreamClosed, true, 'upstream request must be aborted when the client goes away');
  } finally { up.server.close(); front.server.close(); }
});

test('a slow viewer does not make the relay buffer the whole upstream body (backpressure)', async () => {
  let produced = 0;
  const up = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4' });
    const chunk = Buffer.alloc(256 * 1024, 7);
    let live = true;
    res.on('close', () => { live = false; });
    const pump = () => {
      while (live) {
        produced += chunk.length;
        if (!res.write(chunk)) return res.once('drain', pump);
        if (produced > 512 * 1024 * 1024) return res.end();
      }
    };
    pump();
  });
  const front = await listen(async (req, res) => {
    sendUpstream(res, await safeRequest(`http://127.0.0.1:${up.port}/`, { checkAddress: allow }));
  });
  try {
    const socket = net.connect(front.port, '127.0.0.1');
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    socket.pause(); // never read: the slowest possible viewer
    await wait(1500);
    // Without backpressure the relay would keep pulling hundreds of MB; with it, socket buffers cap this at a few MB.
    assert.ok(produced < 64 * 1024 * 1024, `upstream was drained to ${(produced / 1048576).toFixed(0)} MB`);
    socket.destroy();
  } finally { up.server.close(); front.server.close(); }
});

test('sendText sets length and type', async () => {
  const s = await listen((req, res) => sendText(res, 200, 'application/vnd.apple.mpegurl', '#EXTM3U\né'));
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/`);
    assert.equal(r.headers.get('content-type'), 'application/vnd.apple.mpegurl');
    assert.equal(await r.text(), '#EXTM3U\né');
  } finally { s.server.close(); }
});
