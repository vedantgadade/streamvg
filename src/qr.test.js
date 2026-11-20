import test from 'node:test';
import assert from 'node:assert/strict';
import { qrModules, qrPath, QR_MAX_BYTES } from './qr.js';

// Decoding was verified against OpenCV's QR detector for versions 1-6 (see the pull request); these tests
// guard the structure so a regression in the encoder is caught without needing a decoder in CI.
const finderAt = (m, x, y) => {
  for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
    const ring = dx === 0 || dx === 6 || dy === 0 || dy === 6, core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
    if (m[y + dy][x + dx] !== (ring || core)) return false;
  }
  return true;
};

test('size grows with the payload (versions 1-6) and the remote-link payload fits', () => {
  assert.equal(qrModules('a').length, 21);
  assert.equal(qrModules('x'.repeat(18)).length, 25);
  assert.equal(qrModules('x'.repeat(54)).length, 33);
  assert.equal(qrModules('x'.repeat(QR_MAX_BYTES)).length, 41);
  assert.ok(qrModules('https://streamvg.pages.dev/?remote=' + 'a'.repeat(32)).length <= 33);
});

test('finder patterns, timing patterns and the dark module are in place', () => {
  const m = qrModules('https://streamvg.pages.dev/?remote=0123456789abcdef0123456789abcdef');
  const n = m.length;
  assert.ok(finderAt(m, 0, 0) && finderAt(m, n - 7, 0) && finderAt(m, 0, n - 7));
  for (let i = 8; i < n - 8; i++) { assert.equal(m[6][i], i % 2 === 0); assert.equal(m[i][6], i % 2 === 0); }
  assert.equal(m[n - 8][8], true);
});

test('output is deterministic and differs between payloads', () => {
  assert.deepEqual(qrModules('hello'), qrModules('hello'));
  assert.notDeepEqual(qrModules('hello'), qrModules('hellp'));
});

test('too-long input throws instead of producing a broken code', () => {
  assert.throws(() => qrModules('x'.repeat(QR_MAX_BYTES + 1)), RangeError);
});

test('qrPath adds the quiet zone and draws one cell per dark module', () => {
  const { size, d } = qrPath('hi');
  assert.equal(size, 21 + 8);
  const dark = qrModules('hi').flat().filter(Boolean).length;
  assert.equal((d.match(/M/g) || []).length, dark);
  assert.ok(d.startsWith('M4 4h1v1h-1z'), 'top-left finder corner starts after a 4-module quiet zone');
});
