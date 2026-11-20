// Small in-memory building blocks: CORS allowlist, rate limiting, concurrency slots.

const DEFAULT_ORIGINS = ['https://streamvg.pages.dev'];
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+\.streamvg\.pages\.dev$/;

/** ALLOWED_ORIGINS is a comma separated list of extra exact origins. */
export function createOriginCheck(extra = process.env.ALLOWED_ORIGINS || '') {
  const exact = new Set([...DEFAULT_ORIGINS, ...String(extra).split(',').map(x => x.trim().replace(/\/$/, '')).filter(Boolean)]);
  return origin => (origin && (exact.has(origin) || PREVIEW_ORIGIN.test(origin))) ? origin : null;
}

/** Sets CORS headers for allowed origins only (never "*"). */
export function applyCors(originCheck, req, res, methods = 'GET,OPTIONS', headers = 'Range,Content-Type') {
  res.setHeader('Vary', 'Origin');
  const origin = originCheck(String(req.headers.origin || ''));
  if (!origin) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', headers);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges,Content-Type');
  return true;
}

/** Fixed-window counter per key. `now` is injectable for tests. */
export function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();
  const sweep = () => { const t = now(); for (const [k, v] of hits) if (t - v.at > windowMs * 2) hits.delete(k); };
  const timer = setInterval(sweep, Math.max(windowMs, 1000));
  timer.unref?.();
  return {
    take(key) {
      const t = now();
      let x = hits.get(key);
      if (!x || t - x.at > windowMs) { x = { at: t, count: 0 }; hits.set(key, x); }
      x.count++;
      return x.count <= limit ? { ok: true, retryAfter: 0 } : { ok: false, retryAfter: Math.max(1, Math.ceil((x.at + windowMs - t) / 1000)) };
    },
    sweep,
    size: () => hits.size,
  };
}

/** Caps concurrent work: `perKey` per client and `total` overall. acquire() returns a release fn or null. */
export function createSlots({ perKey, total }) {
  const byKey = new Map();
  let active = 0;
  return {
    acquire(key) {
      const n = byKey.get(key) || 0;
      if (active >= total || n >= perKey) return null;
      byKey.set(key, n + 1); active++;
      let released = false;
      return () => {
        if (released) return;
        released = true; active--;
        const left = (byKey.get(key) || 1) - 1;
        if (left <= 0) byKey.delete(key); else byKey.set(key, left);
      };
    },
    active: () => active,
  };
}
