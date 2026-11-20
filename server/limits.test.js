import test from 'node:test';
import assert from 'node:assert/strict';
import { createOriginCheck, applyCors, createRateLimiter, createSlots } from './limits.js';

test('origin allowlist: production, previews and ALLOWED_ORIGINS only', () => {
  const check = createOriginCheck('https://my.example.com/, http://localhost:5173');
  assert.equal(check('https://streamvg.pages.dev'), 'https://streamvg.pages.dev');
  assert.equal(check('https://abc123.streamvg.pages.dev'), 'https://abc123.streamvg.pages.dev');
  assert.equal(check('https://my.example.com'), 'https://my.example.com');
  assert.equal(check('http://localhost:5173'), 'http://localhost:5173');
  for (const bad of ['https://evil.example', 'https://streamvg.pages.dev.evil.example', 'http://streamvg.pages.dev', 'https://a.b.streamvg.pages.dev', 'null', '', undefined])
    assert.equal(check(bad), null, String(bad));
});

test('applyCors never emits a wildcard and always varies on Origin', () => {
  const check = createOriginCheck('');
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; } };
  assert.equal(applyCors(check, { headers: { origin: 'https://evil.example' } }, res), false);
  assert.equal(headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(headers.Vary, 'Origin');
  assert.equal(applyCors(check, { headers: { origin: 'https://streamvg.pages.dev' } }, res), true);
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://streamvg.pages.dev');
});

test('rate limiter counts per key per window and reports retry-after', () => {
  let t = 1000;
  const rl = createRateLimiter({ limit: 3, windowMs: 60000, now: () => t });
  assert.ok(rl.take('a').ok && rl.take('a').ok && rl.take('a').ok);
  const blocked = rl.take('a');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfter >= 1 && blocked.retryAfter <= 60);
  assert.ok(rl.take('b').ok, 'other clients are unaffected');
  t += 60001;
  assert.ok(rl.take('a').ok, 'window resets');
  t += 200000; rl.sweep();
  assert.equal(rl.size(), 0);
});

test('slots cap concurrency per key and in total and release exactly once', () => {
  const slots = createSlots({ perKey: 2, total: 3 });
  const a1 = slots.acquire('a'), a2 = slots.acquire('a');
  assert.ok(a1 && a2);
  assert.equal(slots.acquire('a'), null, 'per-key cap');
  const b1 = slots.acquire('b');
  assert.ok(b1);
  assert.equal(slots.acquire('c'), null, 'total cap');
  a1(); a1(); // double release must not free a second slot
  assert.equal(slots.active(), 2);
  assert.ok(slots.acquire('c'));
});
