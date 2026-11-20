import { pipeline } from 'node:stream';

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

/**
 * Streams an upstream response to the client with backpressure (pipeline pauses
 * the upstream socket while the viewer is slow) and aborts the upstream
 * download as soon as the viewer disconnects.
 */
export function sendUpstream(res, upstream, extraHeaders = {}) {
  res.statusCode = upstream.status;
  for (const name of PASS_HEADERS) {
    const value = upstream.headers[name];
    if (value) res.setHeader(name, value);
  }
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  pipeline(upstream.stream, res, () => {});
  res.on('close', () => { if (!upstream.stream.destroyed) upstream.stream.destroy(); });
}

export function sendText(res, status, contentType, text) {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}
