// Playlist/manifest rewriting for the streaming relay and CORS proxy.

export const b64u = text => Buffer.from(String(text), 'utf8').toString('base64url');
export const unb64u = text => Buffer.from(String(text), 'base64url').toString('utf8');

export const isM3u8 = (contentType, pathname) =>
  /mpegurl|m3u8/i.test(contentType || '') || /\.m3u8$/i.test(pathname || '');
export const isMpd = (contentType, pathname) =>
  /dash\+xml/i.test(contentType || '') || /\.mpd$/i.test(pathname || '');

/**
 * Rewrites every URL in an HLS playlist: plain URI lines AND URI="..." attributes
 * (#EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF, ...), which
 * the previous line-only rewrite left pointing at the original host.
 * `proxyFor(absoluteUrl)` returns the replacement URL.
 */
export function rewriteM3u8(text, baseUrl, proxyFor) {
  const resolve = value => {
    try { return proxyFor(new URL(value, baseUrl).href); } catch { return null; }
  };
  return text.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) {
      return line.replace(/URI="([^"]*)"/g, (whole, value) => {
        if (!value || /^data:/i.test(value)) return whole;
        const next = resolve(value);
        return next ? 'URI="' + next + '"' : whole;
      });
    }
    return resolve(line.trim()) ?? line;
  }).join('\n');
}

/**
 * Makes a DASH manifest fetch its segments through the proxy. Relative segment
 * URLs resolve against the manifest URL, which is the proxy URL, so they used
 * to 404. `proxyBase(absoluteDirectoryUrl)` must return a proxied URL ending
 * in "/". Nested relative <BaseURL>s then resolve against it naturally.
 */
export function rewriteMpd(xml, manifestUrl, proxyBase) {
  const periodAt = xml.search(/<Period[\s>]/);
  const baseDir = value => new URL('.', value).href;
  let sawTopLevel = false;
  let out = xml.replace(/<BaseURL([^>]*)>([\s\S]*?)<\/BaseURL>/g, (whole, attrs, value, offset) => {
    const trimmed = value.trim();
    const top = periodAt < 0 || offset < periodAt;
    let absolute;
    try { absolute = new URL(trimmed, manifestUrl).href; } catch { return whole; }
    const isAbsolute = /^https?:\/\//i.test(trimmed);
    if (!top && !isAbsolute) return whole;
    if (top) sawTopLevel = true;
    return '<BaseURL' + attrs + '>' + proxyBase(baseDir(absolute)) + '</BaseURL>';
  });
  if (!sawTopLevel && periodAt >= 0) {
    const at = out.search(/<Period[\s>]/);
    out = out.slice(0, at) + '<BaseURL>' + proxyBase(baseDir(manifestUrl)) + '</BaseURL>' + out.slice(at);
  }
  return out;
}

/** Resolves the tail of /api/proxy-path/:dir/<rest> without allowing a host change. */
export function resolveProxyPath(dirUrl, restSegments, query = '') {
  const dir = new URL(dirUrl);
  const rest = Array.isArray(restSegments) ? restSegments.join('/') : String(restSegments || '');
  const target = new URL('./' + rest + (query ? '?' + query : ''), dir);
  if (target.origin !== dir.origin) throw new Error('Path escapes upstream host');
  return target;
}
