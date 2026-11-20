// Outbound networking helpers that refuse to talk to private/internal addresses.
//
// Why this exists: checking a hostname with dns.lookup() and then calling fetch()
// resolves the name twice, so a hostile DNS server can answer "public" the first
// time and "127.0.0.1" the second (DNS rebinding). Redirects had the same gap.
// Here the address check runs inside the lookup that the socket actually uses,
// and every redirect hop is validated again.
import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';

export class BlockedError extends Error {
  constructor(message = 'URL not allowed') {
    super(message);
    this.name = 'BlockedError';
    this.code = 'EBLOCKED';
  }
}

const blockList = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockList.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blockList.addSubnet(addr, bits, 'ipv6');

// "::ffff:7f00:1" (how URL normalises IPv4-mapped IPv6) -> "127.0.0.1"
function unmapIpv4(address) {
  let normal;
  try { normal = new URL('http://[' + address + ']/').hostname.slice(1, -1); } catch { return null; }
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normal);
  if (!m) return null;
  const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

/** True when `ip` is not a plain public unicast address (or is not an IP at all). */
export function isBlockedIp(ip) {
  let a = String(ip ?? '').trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const family = net.isIP(a);
  if (!family) return true;
  if (family === 6) {
    const v4 = unmapIpv4(a);
    if (v4) return blockList.check(v4, 'ipv4');
    return blockList.check(a, 'ipv6');
  }
  return blockList.check(a, 'ipv4');
}

/** Name-based rules that DNS alone would not catch. */
export function isBlockedName(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return !h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
}

/** Throws BlockedError unless the host is a public name/address right now. */
export async function assertPublicHost(hostname, checkAddress = isBlockedIp) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '');
  if (isBlockedName(h)) throw new BlockedError();
  if (net.isIP(h)) {
    if (checkAddress(h)) throw new BlockedError();
    return;
  }
  let addrs;
  try { addrs = await dns.promises.lookup(h, { all: true }); } catch { throw new BlockedError('Host not found'); }
  if (!addrs.length || addrs.some(x => checkAddress(x.address))) throw new BlockedError();
}

/** dns.lookup replacement for http(s).request({ lookup }) that rejects non-public answers. */
export function guardedLookup(checkAddress = isBlockedIp) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return callback(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: options.family || 4 }];
      if (!list.length || list.some(x => checkAddress(x.address))) return callback(new BlockedError('Host not allowed'));
      if (options.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * GET/HEAD a public URL. Follows redirects itself, validating every hop, and
 * resolves with { status, headers, url, stream } where `stream` is the raw
 * response (so callers can pipe it with backpressure).
 */
export function safeRequest(input, {
  method = 'GET', headers = {}, headerTimeout = 15000, maxRedirects = 5,
  signal, checkAddress = isBlockedIp,
} = {}) {
  return new Promise((resolve, reject) => {
    const hop = (urlText, count) => {
      let u;
      try { u = new URL(urlText); } catch { return reject(new BlockedError('Invalid URL')); }
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return reject(new BlockedError());
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (isBlockedName(host) || (net.isIP(host) && checkAddress(host))) return reject(new BlockedError());
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, {
        method,
        headers: { 'accept-encoding': 'identity', ...headers },
        lookup: guardedLookup(checkAddress),
        signal,
      }, res => {
        req.setTimeout(0); // headers arrived; a paused viewer must not kill the transfer
        if (REDIRECTS.has(res.statusCode) && res.headers.location) {
          res.resume();
          if (count >= maxRedirects) return reject(new Error('Too many redirects'));
          let next;
          try { next = new URL(res.headers.location, u).href; } catch { return reject(new BlockedError('Invalid redirect')); }
          return hop(next, count + 1);
        }
        resolve({ status: res.statusCode, headers: res.headers, url: u.href, stream: res });
      });
      req.setTimeout(headerTimeout, () => req.destroy(new Error('Upstream timeout')));
      req.on('error', reject);
      req.end();
    };
    hop(String(input), 0);
  });
}

/** Reads at most `limit` bytes as UTF-8 text and stops the download beyond that. */
export async function readText(stream, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) { chunks.push(chunk.subarray(0, chunk.length - (size - limit))); stream.destroy(); break; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
