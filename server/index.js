import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { assertPublicHost, safeRequest, readText, BlockedError } from './safe-net.js';
import { b64u, unb64u, isM3u8, isMpd, rewriteM3u8, rewriteMpd, resolveProxyPath } from './rewrite.js';
import { createOriginCheck, applyCors, createRateLimiter, createSlots } from './limits.js';
import { sendUpstream, sendText } from './relay.js';

const execFileAsync = promisify(execFile);
const app = express();
// Railway puts exactly one proxy in front of us. Trusting only that hop means req.ip is the address
// the proxy saw, not a client-supplied X-Forwarded-For value (which made rate limiting spoofable).
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
app.disable('x-powered-by');

const API_PUBLIC = (process.env.PUBLIC_API_URL || 'https://streamvg-web-production-22879f12.up.railway.app').replace(/\/$/, '');
const originCheck = createOriginCheck();
const clientIp = req => req.ip || req.socket.remoteAddress || 'unknown';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- limits -----------------------------------------------------------------------------------
const generalLimit = createRateLimiter({ limit: 300, windowMs: 60_000 });
const resolveLimit = createRateLimiter({ limit: 30, windowMs: 60_000 });
const uploadLimit = createRateLimiter({ limit: 8, windowMs: 60 * 60_000 });
const heavyLimit = createRateLimiter({ limit: 40, windowMs: 60_000 });
const streamSlots = createSlots({ perKey: 12, total: 300 });
const uploadSlots = createSlots({ perKey: 1, total: 4 });
const ffmpegSlots = createSlots({ perKey: 3, total: 8 });
const remuxSlots = createSlots({ perKey: 1, total: 2 });

const limited = limiter => (req, res, next) => {
  const verdict = limiter.take(clientIp(req));
  if (verdict.ok) return next();
  applyCors(originCheck, req, res, 'GET,POST,OPTIONS');
  res.setHeader('Retry-After', String(verdict.retryAfter));
  res.status(429).json({ error: 'Too many requests. Try again shortly.' });
};
const cors = (methods, headers) => (req, res, next) => { applyCors(originCheck, req, res, methods, headers); next(); };
const allowApi = [limited(generalLimit), cors('GET,OPTIONS', 'Range,Content-Type')];

app.use('/api', express.json({ limit: '16kb' }));
app.options('/api/*splat', (req, res) => {
  applyCors(originCheck, req, res, 'GET,POST,OPTIONS', 'Content-Type,Range,X-StreamVG-File-Name');
  res.sendStatus(204);
});

// ---- phone remote (in-memory fallback; production uses the Cloudflare Pages Functions) ----------
const remoteSessions = new Map();
const REMOTE_TTL = 15 * 60 * 1000;
const remoteGet = code => { const item = remoteSessions.get(code); if (!item || item.expires < Date.now()) { remoteSessions.delete(code); return null; } return item; };
const remoteHeaders = [limited(generalLimit), cors('GET,POST,OPTIONS', 'Content-Type'), (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }];
app.post('/api/remote/create', remoteHeaders, (req, res) => {
  if (remoteSessions.size > 500) for (const [k, v] of remoteSessions) if (v.expires < Date.now()) remoteSessions.delete(k);
  if (remoteSessions.size > 5000) return res.status(503).json({ error: 'Too many active TV connections.' });
  const code = randomUUID().replace(/-/g, '');
  remoteSessions.set(code, { expires: Date.now() + REMOTE_TTL, pendingUrl: '', seq: 0 });
  res.json({ code, expiresIn: REMOTE_TTL / 1000 });
});
app.get('/api/remote/:code/poll', remoteHeaders, (req, res) => {
  const item = remoteGet(req.params.code);
  if (!item) return res.status(410).json({ error: 'This TV connection has expired. Create a new QR code.' });
  const url = item.pendingUrl; item.pendingUrl = '';
  res.json({ url: url || null, id: url ? item.seq : null, expiresIn: Math.max(0, Math.floor((item.expires - Date.now()) / 1000)) });
});
app.post('/api/remote/:code/play', remoteHeaders, (req, res) => {
  const item = remoteGet(req.params.code);
  if (!item) return res.status(410).json({ error: 'This TV connection has expired. Scan a new QR code.' });
  const value = String(req.body?.url || '').trim();
  if (value.length > 8192) return res.status(413).json({ error: 'The video URL is too long.' });
  try { if (!['http:', 'https:'].includes(new URL(value).protocol)) throw new Error(); } catch { return res.status(400).json({ error: 'Please send a valid http or https video URL.' }); }
  item.pendingUrl = value; item.seq++;
  res.json({ ok: true });
});

// ---- local media: upload once, then extract audio / subtitles / a browser-playable MP4 ----------
const LOCAL_MEDIA_TTL = 30 * 60 * 1000;
const LOCAL_MEDIA_DIR = process.env.LOCAL_MEDIA_DIR || '/tmp/streamvg-local';
const LOCAL_MEDIA_MAX = Number(process.env.LOCAL_MEDIA_MAX_BYTES) || 8 * 1024 ** 3; // per file
const LOCAL_MEDIA_TOTAL = Number(process.env.LOCAL_MEDIA_TOTAL_BYTES) || 16 * 1024 ** 3; // across all sessions
const MAX_LOCAL_SESSIONS = 12;
const REMUX_TIMEOUT = 20 * 60 * 1000;
const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'ttml']);
const localMediaStore = new Map();
let localDiskUsed = 0;

const localMediaCleanup = async token => {
  const item = localMediaStore.get(token);
  if (!item) return;
  localMediaStore.delete(token);
  localDiskUsed = Math.max(0, localDiskUsed - item.size - (item.remux?.size || 0));
  await unlink(item.path).catch(() => {});
  if (item.remux?.path) await unlink(item.remux.path).catch(() => {});
};
const localGet = (req, res) => {
  const item = localMediaStore.get(req.params.token);
  if (!item || item.expires < Date.now()) { if (item) localMediaCleanup(req.params.token); res.status(410).json({ error: 'Local media session expired.' }); return null; }
  item.expires = Date.now() + LOCAL_MEDIA_TTL;
  return item;
};
const audioStreams = item => item.streams.filter(x => x.codec_type === 'audio');
const subtitleStreams = item => item.streams.filter(x => x.codec_type === 'subtitle');
const parseSeconds = value => { const n = Number(value ?? 0); return Number.isFinite(n) && n >= 0 ? n : NaN; };

app.post('/api/local-session', cors('POST,OPTIONS', 'Content-Type,X-StreamVG-File-Name'), async (req, res) => {
  const ip = clientIp(req);
  const verdict = uploadLimit.take(ip);
  if (!verdict.ok) { res.setHeader('Retry-After', String(verdict.retryAfter)); return res.status(429).json({ error: 'Too many uploads. Try again later.' }); }
  if (localMediaStore.size >= MAX_LOCAL_SESSIONS) return res.status(503).json({ error: 'The media engine is busy. Try again in a few minutes.' });
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > LOCAL_MEDIA_MAX) return res.status(413).json({ error: 'Local file is too large for the server media engine.' });
  if (localDiskUsed + declared > LOCAL_MEDIA_TOTAL) return res.status(507).json({ error: 'Server storage is full. Try again in a few minutes.' });
  const release = uploadSlots.acquire(ip);
  if (!release) return res.status(429).json({ error: 'Another upload is already in progress.' });
  const token = randomUUID(), filePath = path.join(LOCAL_MEDIA_DIR, token + '.media');
  let bytes = 0;
  // Count and cap inside the pipeline. (A separate req.on('data') listener starts the request flowing
  // immediately, so chunks that arrive while we await mkdir() were silently dropped from the saved file.)
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length; localDiskUsed += chunk.length;
      if (bytes > LOCAL_MEDIA_MAX || localDiskUsed > LOCAL_MEDIA_TOTAL) return callback(Object.assign(new Error('Local file exceeds the server upload limit.'), { status: 413 }));
      callback(null, chunk);
    },
  });
  try {
    await mkdir(LOCAL_MEDIA_DIR, { recursive: true });
    await pipeline(req, counter, createWriteStream(filePath));
    console.log(JSON.stringify({ event: 'local-media-upload-complete', token, size: bytes }));
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath], { timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
    const probe = JSON.parse(stdout || '{}');
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    if (!streams.some(x => x.codec_type === 'audio' || x.codec_type === 'video')) { const err = new Error('No audio or video stream found in local media.'); err.status = 422; throw err; }
    const duration = Number(probe.format?.duration) || 0;
    localMediaStore.set(token, { path: filePath, streams, duration, size: bytes, expires: Date.now() + LOCAL_MEDIA_TTL });
    res.json({ token, size: bytes, duration, streams });
  } catch (err) {
    localDiskUsed = Math.max(0, localDiskUsed - bytes);
    await unlink(filePath).catch(() => {});
    console.error(JSON.stringify({ event: 'local-media-session-error', error: String(err?.message || err).slice(0, 400) }));
    if (!res.headersSent) {
      if (err?.status === 413) res.setHeader('Connection', 'close'); // the rest of the oversized body is not wanted
      res.status(err?.status || 500).json({ error: String(err?.message || 'Local media session failed') });
    }
  } finally { release(); }
});

// Audio of one track as fragmented MP4. `start` (seconds) restarts extraction there so seeking works
// even though the stream itself is not seekable.
app.get('/api/local-audio/:token', limited(heavyLimit), cors('GET,OPTIONS', 'Range,Content-Type'), (req, res) => {
  const item = localGet(req, res); if (!item) return;
  const track = Number(req.query.track ?? 0), start = parseSeconds(req.query.start);
  if (!Number.isFinite(start)) return res.status(400).json({ error: 'Invalid audio start time.' });
  const audio = audioStreams(item);
  if (!Number.isInteger(track) || track < 0 || track >= audio.length) return res.status(400).json({ error: 'Invalid audio track.' });
  const release = ffmpegSlots.acquire(clientIp(req));
  if (!release) return res.status(429).json({ error: 'Too many audio conversions in progress.' });
  const codec = String(audio[track].codec_name || '');
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...(start > 0 ? ['-ss', String(start)] : []), '-i', item.path, '-map', '0:a:' + track, '-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  ff.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  ff.once('error', err => { release(); console.error(JSON.stringify({ event: 'local-audio-error', track, codec, error: String(err?.message || err) })); if (!res.headersSent) res.status(500).json({ error: 'FFmpeg could not start' }); else res.destroy(err); });
  ff.once('close', code => { release(); if (code !== 0 && code !== null && !res.destroyed) { console.error(JSON.stringify({ event: 'local-audio-failed', track, codec, code, stderr: stderr.slice(-1000) })); res.destroy(new Error('FFmpeg audio extraction failed')); } });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'audio/mp4'); res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-StreamVG-Audio-Codec', codec); res.setHeader('X-StreamVG-Audio-Track', String(track));
  ff.stdout.pipe(res);
  // The response 'close' (not the request's, which fires when the request is merely read) means the viewer is gone.
  res.on('close', () => { if (!ff.killed && ff.exitCode === null) ff.kill('SIGTERM'); });
});

// Text subtitle track as WebVTT.
app.get('/api/local-subtitle/:token/:track', limited(heavyLimit), cors('GET,OPTIONS', 'Content-Type'), async (req, res) => {
  const item = localGet(req, res); if (!item) return;
  const subs = subtitleStreams(item), track = Number(req.params.track);
  if (!Number.isInteger(track) || track < 0 || track >= subs.length) return res.status(400).json({ error: 'Invalid subtitle track.' });
  if (!TEXT_SUBTITLE_CODECS.has(String(subs[track].codec_name || '').toLowerCase())) return res.status(415).json({ error: 'This subtitle is image-based and cannot be shown as text.' });
  const release = ffmpegSlots.acquire(clientIp(req));
  if (!release) return res.status(429).json({ error: 'Too many conversions in progress.' });
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', item.path, '-map', '0:s:' + track, '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1'], { timeout: 120000, maxBuffer: 12 * 1024 * 1024, encoding: 'buffer' });
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
    res.send(stdout);
  } catch { res.status(422).json({ error: 'Could not convert this subtitle track.' }); } finally { release(); }
});

// Browser-playable MP4 (video copied, audio -> AAC) for containers the browser cannot open itself.
// Written to disk so the result is served with Range support and is fully seekable.
app.post('/api/local-remux/:token', limited(heavyLimit), cors('POST,OPTIONS', 'Content-Type'), async (req, res) => {
  const item = localGet(req, res); if (!item) return;
  const audio = audioStreams(item), track = Number(req.query.track ?? 0);
  if (!item.streams.some(x => x.codec_type === 'video')) return res.status(422).json({ error: 'No video stream found in this file.' });
  if (audio.length && (!Number.isInteger(track) || track < 0 || track >= audio.length)) return res.status(400).json({ error: 'Invalid audio track.' });
  const url = '/api/local-media/' + req.params.token + '/video.mp4?track=' + track;
  if (item.remux && item.remux.track === track) return res.json({ url, size: item.remux.size, duration: item.duration });
  const release = remuxSlots.acquire(clientIp(req));
  if (!release) return res.status(429).json({ error: 'A conversion is already running. Try again shortly.' });
  const outPath = path.join(LOCAL_MEDIA_DIR, req.params.token + '.remux-' + track + '.mp4');
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', item.path, '-map', '0:v:0', ...(audio.length ? ['-map', '0:a:' + track, '-c:a', 'aac', '-b:a', '192k', '-ac', '2'] : []), '-c:v', 'copy', '-sn', '-dn', '-map_metadata', '-1', '-movflags', '+faststart', outPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '', finished = false;
  ff.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const killTimer = setTimeout(() => ff.kill('SIGKILL'), REMUX_TIMEOUT);
  res.on('close', () => { if (!finished && ff.exitCode === null) ff.kill('SIGTERM'); });
  const code = await new Promise(resolve => { ff.once('error', () => resolve(-1)); ff.once('close', resolve); });
  finished = true; clearTimeout(killTimer); release();
  const discard = () => unlink(outPath).catch(() => {});
  if (!localMediaStore.has(req.params.token) || res.destroyed) return discard();
  if (code !== 0) {
    await discard();
    console.error(JSON.stringify({ event: 'local-remux-failed', code, stderr: stderr.slice(-800) }));
    return res.status(422).json({ error: 'This file cannot be converted for browser playback (' + (stderr.trim().split('\n').pop() || 'unsupported codec').slice(0, 160) + ').' });
  }
  const { size } = await stat(outPath);
  if (localDiskUsed + size > LOCAL_MEDIA_TOTAL) { await discard(); return res.status(507).json({ error: 'Server storage is full. Try again in a few minutes.' }); }
  if (item.remux?.path && item.remux.path !== outPath) { await unlink(item.remux.path).catch(() => {}); localDiskUsed = Math.max(0, localDiskUsed - item.remux.size); }
  item.remux = { path: outPath, size, track }; localDiskUsed += size;
  res.json({ url, size, duration: item.duration });
});
app.get('/api/local-media/:token/video.mp4', cors('GET,OPTIONS', 'Range,Content-Type'), (req, res) => {
  const item = localGet(req, res); if (!item) return;
  if (!item.remux) return res.status(404).json({ error: 'Nothing has been converted for this session yet.' });
  res.sendFile(item.remux.path, { headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' } }, err => { if (err && !res.headersSent) res.status(err.status || 500).end(); });
});

// ---- remote media: tracks of a remote file, and a source-quality / compatible HLS remux ----------
// ffmpeg and ffprobe fetch the URL themselves, so it is validated first (every redirect hop is checked and
// the final address must be public), only http(s) is allowed, and playlists are refused because their
// segment URLs would be fetched by ffmpeg without these checks.
const FFMPEG_NET = ['-protocol_whitelist', 'http,https,tcp,tls,crypto', '-rw_timeout', '30000000'];
const MANIFEST_RE = /\.(m3u8|mpd)(?:[?#]|$)/i;
const publicMediaUrl = async value => {
  const text = String(value || '').trim();
  if (!text || text.length > 8192) throw Object.assign(new Error('A valid media URL is required.'), { status: 400 });
  let u; try { u = new URL(text); } catch { throw Object.assign(new Error('A valid media URL is required.'), { status: 400 }); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Object.assign(new Error('This media URL is not allowed.'), { status: 400 });
  let probe;
  try { probe = await safeRequest(u.href, { headers: { range: 'bytes=0-0', 'user-agent': 'Mozilla/5.0 StreamVG Media Probe' }, headerTimeout: 15000, maxRedirects: 5 }); }
  catch (err) { if (err instanceof BlockedError) throw Object.assign(new Error('This media URL is not allowed.'), { status: 400 }); throw Object.assign(new Error('Could not open this media link.'), { status: 422 }); }
  probe.stream.destroy();
  const type = String(probe.headers['content-type'] || '').toLowerCase();
  if (probe.status >= 400 || type.includes('text/html') || type.includes('application/json')) throw Object.assign(new Error('The media link is unavailable or expired.'), { status: 422 });
  const final = String(probe.url || u.href);
  if (MANIFEST_RE.test(new URL(final).pathname) || /mpegurl|dash\+xml/.test(type)) throw Object.assign(new Error('Playlists are not supported here; only direct media files.'), { status: 422 });
  return final;
};
const mediaError = (res, err, fallback) => res.status(err?.status || 422).json({ error: err?.status ? err.message : fallback });

const REMOTE_MEDIA_TTL = 30 * 60 * 1000;
const remoteMediaStore = new Map();
const remoteMediaGet = (req, res) => {
  const item = remoteMediaStore.get(req.params.token);
  if (!item || item.expires < Date.now()) { remoteMediaStore.delete(req.params.token); res.status(410).json({ error: 'Remote media session expired. Load the video again.' }); return null; }
  item.expires = Date.now() + REMOTE_MEDIA_TTL;
  return item;
};
app.post('/api/remote-media-session', limited(heavyLimit), cors('GET,POST,OPTIONS', 'Content-Type,Range'), async (req, res) => {
  const release = ffmpegSlots.acquire(clientIp(req));
  if (!release) return res.status(429).json({ error: 'Too many media scans in progress.' });
  try {
    const target = await publicMediaUrl(req.body?.url);
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', ...FFMPEG_NET, '-probesize', '100M', '-analyzeduration', '100M', '-show_streams', '-show_format', '-of', 'json', target], { timeout: 90000, maxBuffer: 20 * 1024 * 1024 });
    const streams = Array.isArray(JSON.parse(stdout || '{}').streams) ? JSON.parse(stdout).streams : [];
    if (!streams.some(x => x.codec_type === 'audio' || x.codec_type === 'subtitle')) return res.status(422).json({ error: 'No audio or subtitle tracks were found.' });
    for (const [key, v] of remoteMediaStore) if (v.expires < Date.now()) remoteMediaStore.delete(key);
    if (remoteMediaStore.size >= 200) return res.status(503).json({ error: 'The media engine is busy. Try again shortly.' });
    const token = randomUUID();
    remoteMediaStore.set(token, { url: target, streams, expires: Date.now() + REMOTE_MEDIA_TTL });
    const publicStreams = streams.filter(x => x.codec_type === 'audio' || x.codec_type === 'subtitle').map(x => ({ index: x.index, codec_type: x.codec_type, codec_name: x.codec_name || '', language: x.tags?.language || x.tags?.language_ietf || '', title: x.tags?.title || x.tags?.handler_name || '', channels: x.channels || 0, channel_layout: x.channel_layout || '', sample_rate: x.sample_rate || '' }));
    res.json({ token, expiresIn: REMOTE_MEDIA_TTL / 1000, streams: publicStreams });
  } catch (err) {
    console.error(JSON.stringify({ event: 'remote-media-probe-error', message: String(err?.message || err).slice(0, 240) }));
    mediaError(res, err, 'Could not read tracks from this URL. The link may have expired or the server may not support this source.');
  } finally { release(); }
});
app.get('/api/remote-audio/:token', limited(heavyLimit), cors('GET,OPTIONS', 'Range,Content-Type'), (req, res) => {
  const item = remoteMediaGet(req, res); if (!item) return;
  const audio = audioStreams(item), track = Number(req.query.track ?? 0), start = parseSeconds(req.query.start);
  if (!Number.isInteger(track) || track < 0 || track >= audio.length) return res.status(400).json({ error: 'Invalid audio track.' });
  if (!Number.isFinite(start) || start > 86400) return res.status(400).json({ error: 'Invalid audio start time.' });
  const release = ffmpegSlots.acquire(clientIp(req));
  if (!release) return res.status(429).json({ error: 'Too many audio conversions in progress.' });
  const codec = String(audio[track].codec_name || '').toLowerCase();
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...FFMPEG_NET, ...(start > 0 ? ['-ss', String(start)] : []), '-i', item.url, '-map', '0:' + audio[track].index, '-vn', '-sn', '-dn', ...(codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '384k']), '-avoid_negative_ts', 'make_zero', '-movflags', '+empty_moov+default_base_moof', '-frag_duration', '500000', '-flush_packets', '1', '-f', 'mp4', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  ff.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  ff.once('error', err => { release(); if (!res.headersSent) res.status(502).json({ error: 'Audio extraction failed' }); else res.destroy(err); });
  ff.once('close', code => { release(); if (code !== 0 && code !== null) console.error(JSON.stringify({ event: 'remote-audio-exit', track, code, stderr: stderr.slice(-800) })); });
  res.status(200); res.setHeader('Content-Type', 'audio/mp4'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-StreamVG-Audio-Track', String(track));
  ff.stdout.pipe(res);
  res.on('close', () => { if (!ff.killed && ff.exitCode === null) ff.kill('SIGTERM'); });
});
app.get('/api/remote-subtitle/:token/:track', limited(heavyLimit), cors('GET,OPTIONS', 'Content-Type'), async (req, res) => {
  const item = remoteMediaGet(req, res); if (!item) return;
  const subs = subtitleStreams(item), track = Number(req.params.track);
  if (!Number.isInteger(track) || track < 0 || track >= subs.length) return res.status(400).send('Invalid subtitle track.');
  if (!TEXT_SUBTITLE_CODECS.has(String(subs[track].codec_name || '').toLowerCase())) return res.status(415).send('This subtitle is image-based and cannot be shown as text.');
  const release = ffmpegSlots.acquire(clientIp(req));
  if (!release) return res.status(429).send('Too many conversions in progress.');
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...FFMPEG_NET, '-i', item.url, '-map', '0:' + subs[track].index, '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1'], { timeout: 120000, maxBuffer: 12 * 1024 * 1024, encoding: 'buffer' });
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.send(stdout);
  } catch { res.status(422).send('Could not convert this subtitle track.'); } finally { release(); }
});

// ---- compatibility playback: remote file -> fragmented-MP4 HLS (video copied, or re-encoded as a fallback) ----
const COMPAT_DIR = process.env.COMPAT_DIR || '/tmp/streamvg-compat';
const COMPAT_TTL = 60 * 60 * 1000;
const compatSessions = new Map();
await rm(COMPAT_DIR, { recursive: true, force: true }).catch(() => {});
const compatDrop = async (token, item) => { compatSessions.delete(token); if (item.ff && item.exitCode === undefined) item.ff.kill('SIGTERM'); await rm(item.dir, { recursive: true, force: true }).catch(() => {}); };
const waitForCompatPlaylist = async (job, timeoutMs = 90000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { if ((await stat(path.join(job.dir, 'index.m3u8'))).size > 0) return true; } catch {}
    if (job.exitCode !== undefined) return false;
    await wait(250);
  }
  return false;
};
app.post('/api/compat/session', limited(heavyLimit), cors('GET,POST,OPTIONS', 'Content-Type,Range'), async (req, res) => {
  try {
    const mode = req.body?.mode === 'compatible' ? 'compatible' : 'original';
    const sourceUrl = await publicMediaUrl(req.body?.url);
    for (const [key, v] of compatSessions) if (v.expires < Date.now()) await compatDrop(key, v);
    if (compatSessions.size >= 40) return res.status(503).json({ error: 'The media engine is busy. Try again shortly.' });
    if (mode === 'compatible') for (const item of compatSessions.values()) if (item.url === sourceUrl && item.mode === 'original' && item.ff && item.exitCode === undefined) { const ff = item.ff; ff.kill('SIGTERM'); await new Promise(resolve => { if (item.exitCode !== undefined) return resolve(); ff.once('close', resolve); setTimeout(resolve, 1200).unref(); }); }
    const token = randomUUID(), dir = path.join(COMPAT_DIR, token);
    await mkdir(dir, { recursive: true });
    compatSessions.set(token, { url: sourceUrl, dir, mode, expires: Date.now() + COMPAT_TTL, ff: null, exitCode: undefined, stderr: '' });
    res.json({ url: API_PUBLIC + '/api/compat/' + token + '/index.m3u8', expiresIn: COMPAT_TTL / 1000 });
  } catch (err) { mediaError(res, err, 'Could not open this media link.'); }
});
app.get('/api/compat/:token/:file', allowApi, async (req, res) => {
  const item = compatSessions.get(req.params.token);
  if (!item || item.expires < Date.now()) return res.status(410).send('Compatibility stream expired.');
  const file = req.params.file;
  if (!['index.m3u8', 'init.mp4'].includes(file) && !/^segment-\d{6}\.m4s$/.test(file)) return res.status(404).end();
  if (file === 'index.m3u8' && !item.ff) {
    if (item.mode === 'compatible' && [...compatSessions.values()].filter(x => x.mode === 'compatible' && x.ff && x.exitCode === undefined).length >= 1) return res.status(429).send('The compatibility encoder is busy. Retry shortly.');
    const playlist = path.join(item.dir, 'index.m3u8'), segmentPattern = path.join(item.dir, 'segment-%06d.m4s');
    // Original mode remuxes without quality changes; compatible mode is an explicit fallback for sources the browser cannot decode.
    const codecArgs = item.mode === 'compatible' ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-threads:v', '1', '-c:a', 'aac', '-b:a', '256k', '-ac', '2'] : ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '384k'];
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-filter_threads', '1', '-threads', '1', ...FFMPEG_NET, '-i', item.url, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', ...codecArgs, '-f', 'hls', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_time', '6', '-hls_list_size', '0', '-hls_flags', 'independent_segments+temp_file', '-hls_segment_filename', segmentPattern, playlist], { stdio: ['ignore', 'ignore', 'pipe'] });
    item.ff = ff;
    ff.stderr.on('data', chunk => { item.stderr = (item.stderr + chunk).slice(-6000); });
    ff.once('close', (code, signal) => { item.exitCode = code ?? 1; item.exitSignal = signal; if (code !== 0 && signal !== 'SIGTERM') console.error(JSON.stringify({ event: 'compat-stream-failed', code, signal, stderr: item.stderr.slice(-1000) })); });
    ff.once('error', err => { item.exitCode = 1; item.stderr = String(err?.message || err); });
  }
  if (file === 'index.m3u8' && !await waitForCompatPlaylist(item)) return res.status(503).setHeader('Retry-After', '2').send(item.exitSignal ? 'Source remux stopped (' + item.exitSignal + '). The source codec or container may not be supported.' : 'Could not create a source-quality stream from this link.');
  const filePath = path.join(item.dir, file);
  try { await stat(filePath); } catch { return res.status(404).end(); }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', file === 'index.m3u8' ? 'application/vnd.apple.mpegurl' : file === 'init.mp4' ? 'video/mp4' : 'video/iso.segment');
  createReadStream(filePath).on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); }).pipe(res);
});
setInterval(() => { const now = Date.now(); for (const [k, v] of remoteMediaStore) if (v.expires < now) remoteMediaStore.delete(k); for (const [k, v] of compatSessions) if (v.expires < now) compatDrop(k, v); }, 60000).unref();

// ---- URL resolving ----------------------------------------------------------------------------
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const teraHosts = ['terabox.com', 'terabox.app', 'teraboxshare.com', 'teraboxlink.com', 'teraboxurl.com', 'teraboxapp.com', 'terabox.club', 'terabox.link', 'teraboxfree.com', 'terafileshare.com', 'terasharefile.com', 'terasharelink.com', 'terashareus.com', '1024terabox.com', '1024tera.com', '1024-terabox.com', 'tera1024box.com', 'momerybox.com', 'bestclouddrive.com', '4funbox.in', '4funbox.com', 'mirrobox.com', 'nephobox.com', 'pebibox.com', 'fancybox.in', 'gibibox.com', 'tibibox.com'];
const isTeraHost = h => { const x = String(h || '').toLowerCase().replace(/^www\./, ''); return teraHosts.includes(x) || x.includes('terabox') || x.includes('terafileshare') || x.includes('terashare'); };
const TERABOX_NDUS = String(process.env.TERABOX_NDUS || '').trim();
const teraAuthHeaders = () => TERABOX_NDUS ? { cookie: 'ndus=' + TERABOX_NDUS } : {};
// Third-party TeraBox resolvers. Defaults keep the previous behaviour; override to point at your own.
const ITERAPLAY_URL = process.env.ITERAPLAY_URL || 'https://iteraplay.com/api/play.php';
const ITERAPLAY_KEY = process.env.ITERAPLAY_KEY || 'iTeraPlay2025';
const TERABOX_WORKER_URL = process.env.TERABOX_WORKER_URL || 'https://terabox-worker.robinkumarshakya103.workers.dev/api';
const TBX_PROXY_BASE = (process.env.TBX_PROXY_URL || 'https://tbx-proxy.shakir-ansarii075.workers.dev/').replace(/\/?$/, '/');

// Known limitation: yt-dlp follows redirects with its own HTTP stack, which this process cannot
// guard. Restrict the container's egress at the platform level if that matters for your deployment.
const runUniversalExtractor = async (target, signal) => {
  try {
    const ytArgs = ['--dump-single-json', '--no-playlist', '--no-warnings', '--skip-download', '--no-js-runtimes', '--js-runtimes', 'node', '--remote-components', 'ejs:github', '-f', 'best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best', target];
    const { stdout } = await execFileAsync('yt-dlp', ytArgs, { timeout: 25000, maxBuffer: 20 * 1024 * 1024, signal });
    const d = JSON.parse(stdout), formats = Array.isArray(d.formats) ? d.formats : [];
    const usable = formats.filter(x => x?.url && x.vcodec && x.vcodec !== 'none').sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));
    const best = usable[0];
    if (best?.url) return { kind: 'media', url: best.url, headers: { ...(d.http_headers || {}), ...(best.http_headers || {}) }, candidates: usable.slice(0, 20).map(x => ({ url: x.url, width: x.width, height: x.height, bitrate: x.tbr, codec: x.vcodec })), title: d.title || '', width: best.width, height: best.height, codec: best.vcodec, source: 'universal-extractor' };
    if (d.url) return { kind: 'media', url: d.url, headers: d.http_headers || {}, title: d.title || '', width: d.width, height: d.height, codec: d.vcodec || '', source: 'universal-extractor' };
    return null;
  } catch { return null; }
};

const resolveTeraExternal = async target => {
  const auth = teraAuthHeaders();
  const log = (stage, extra = {}) => console.log(JSON.stringify({ event: 'terabox-resolve', stage, target: target.replace(/([?&](?:ndus|cookie|token|key)=)[^&]*/gi, '$1[redacted]'), hasNduCookie: Boolean(TERABOX_NDUS), ...extra }));
  const candidates = [target];
  try {
    const page = await safeRequest(target, { headers: { 'user-agent': 'Mozilla/5.0 StreamVG Resolver', ...auth }, headerTimeout: 8000 });
    log('share-page', { status: page.status, finalUrl: page.url, ok: page.status < 400 });
    if (page.status < 400) {
      if (page.url !== target) candidates.push(page.url);
      const html = await readText(page.stream, 1000000);
      for (const m of html.matchAll(/<(?:link|meta)[^>]+(?:rel|property)\s*=\s*["'](?:canonical|og:url)["'][^>]+(?:href|content)\s*=\s*["']([^"']+)["']/gi)) {
        try { candidates.push(new URL(m[1], page.url).href); } catch {}
      }
    } else page.stream.destroy();
  } catch {}
  try {
    const u = new URL(target), parts = u.pathname.split('/').filter(Boolean), raw = parts[parts.length - 1] || u.searchParams.get('surl');
    if (raw) {
      const code = raw.startsWith('1') ? raw.slice(1) : raw;
      for (const host of ['https://www.terabox.app', 'https://terabox.com', 'https://1024terabox.com']) candidates.push(host + '/sharing/link?surl=' + encodeURIComponent(code));
    }
  } catch {}
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue; seen.add(candidate);
    try {
      const form = new FormData();
      form.append('url', candidate);
      form.append('key', ITERAPLAY_KEY);
      const r = await fetch(ITERAPLAY_URL, { method: 'POST', body: form, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36' }, signal: AbortSignal.timeout(30000) });
      log('iteraplay', { candidate, status: r.status, ok: r.ok });
      if (r.ok) {
        const d = await r.json(), v = d?.data || d;
        if (d?.error || d?.success === false) log('iteraplay-error', { candidate, error: String(d?.error || d?.message || d?.errmsg || 'unknown').slice(0, 300) });
        if (!v?.error && d?.success !== false) {
          const streams = v?.fast_stream_url || v?.stream_url || {};
          const urls = [streams.q_1080, streams.q_720, streams.q_480, streams.q_360, streams['1080'], streams['720'], streams['480'], streams['360'], v?.url, v?.streaming_url].filter(Boolean);
          if (urls[0]) return { kind: 'media', url: urls[0], headers: { 'user-agent': 'Mozilla/5.0 StreamVG Resolver', referer: 'https://iteraplay.com/' }, title: v?.title || v?.name || 'TeraBox video', width: v?.width, height: v?.height, source: 'iteraplay-resolver' };
        }
      }
    } catch {}
  }
  const headers = { 'user-agent': 'Mozilla/5.0 StreamVG Resolver', accept: 'application/json', ...auth };
  for (const candidate of candidates) {
    try {
      const r = await fetch(TERABOX_WORKER_URL + '?url=' + encodeURIComponent(candidate), { headers, redirect: 'follow', signal: AbortSignal.timeout(12000) });
      log('terabox-worker', { candidate, status: r.status, ok: r.ok });
      if (r.ok) {
        const d = await r.json();
        if (d?.success === false || d?.error) log('terabox-worker-error', { candidate, error: String(d?.error || d?.message || d?.errmsg || 'unknown').slice(0, 300) });
        const f = d?.files?.find(x => x?.streaming_url || x?.download_url) || d?.files?.[0], stream = f?.streaming_url || f?.download_url;
        if (stream) return { kind: 'media', url: stream, headers: { ...headers, referer: candidate }, title: f?.file_name || f?.name || d?.title || '', width: f?.width, height: f?.height, source: 'terabox-resolver' };
      }
    } catch {}
  }
  try {
    const u = new URL(target), parts = u.pathname.split('/').filter(Boolean), raw = parts[parts.length - 1] || u.searchParams.get('surl'); if (!raw) return null;
    const surl = raw.startsWith('1') ? raw.slice(1) : raw;
    const rr = await fetch(TBX_PROXY_BASE + '?mode=resolve&surl=' + encodeURIComponent(surl) + '&refresh=1', { headers, redirect: 'follow', signal: AbortSignal.timeout(12000) });
    log('tbx-resolve', { status: rr.status, ok: rr.ok });
    if (rr.ok) {
      const sr = await fetch(TBX_PROXY_BASE + '?mode=stream&surl=' + encodeURIComponent(surl) + '&type=M3U8_AUTO_720', { headers: { ...headers, accept: 'application/vnd.apple.mpegurl,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
      log('tbx-stream', { status: sr.status, ok: sr.ok, contentType: sr.headers.get('content-type') || '' });
      const type = sr.headers.get('content-type') || '';
      if (sr.ok && (type.includes('mpegurl') || type.includes('m3u8') || type.includes('text/plain'))) return { kind: 'media', url: sr.url, headers: { ...headers, referer: target }, title: 'TeraBox video', source: 'terabox-hls-gateway' };
    }
  } catch {}
  log('failed', { reason: 'all-resolvers-exhausted' });
  return null;
};

const abs = (x, base) => { try { return new URL(x, base).href; } catch { return null; } };
const extractMedia = (html, base) => {
  const out = new Set(), add = x => { if (!x) return; const u = abs(x, base); if (!u) return; if (/\.(m3u8|mpd|mp4|webm|m4v|mov|ogv|ogg|mkv|ts)(?:[?#]|$)/i.test(u.toLowerCase())) out.add(u); };
  for (const m of html.matchAll(/<(?:video|source)[^>]+(?:src|data-src)\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/(?:og:video(?::secure_url)?|twitter:player:stream|contentUrl|contentURL)[^>]*?(?:content|contentUrl|contentURL)\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/["']((?:https?:)?\/\/[^"']+\.(?:m3u8|mpd|mp4|webm|m4v|mov|mkv|ts)(?:\?[^"']*)?)["']/gi)) add(m[1]);
  return [...out];
};

// Relay tokens remember which hosts a playlist legitimately references, so a token cannot be used as a general proxy.
const relayStore = new Map();
const relay = (url, headers = {}) => {
  const token = randomUUID();
  relayStore.set(token, { url, headers, hosts: new Set([new URL(url).host]), expires: Date.now() + 10 * 60 * 1000 });
  return token;
};
const relayGet = token => { const x = relayStore.get(token); if (!x || x.expires < Date.now()) { relayStore.delete(token); return null; } return x; };
// `headers` (referer, cookies, tokens some extractors return) are for the relay only and are never sent to the browser.
const relayed = (res, found) => { const { headers, ...publicInfo } = found; const token = relay(found.url, headers); return res.json({ ...publicInfo, url: API_PUBLIC + '/api/stream/' + token, originalUrl: found.url, source: found.source + '-relay' }); };

// Fetches a page and reports what playable media / embeds / TeraBox links it exposes.
const inspectPage = async target => {
  const up = await safeRequest(target, { headers: { 'user-agent': 'Mozilla/5.0 StreamVG Resolver', accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
  const type = up.headers['content-type'] || '';
  if (type.startsWith('video/') || type.includes('mpegurl') || type.includes('dash')) { up.stream.destroy(); return { kind: 'media', url: up.url, contentType: type }; }
  if (!type.includes('html') && !type.includes('xml')) { up.stream.destroy(); return { status: 415, error: 'URL did not return a web page or supported media' }; }
  const html = await readText(up.stream, 5000000);
  const media = extractMedia(html, up.url);
  if (media.length) return { kind: 'media', found: { kind: 'media', url: media[0], headers: { 'user-agent': 'Mozilla/5.0 StreamVG Resolver', referer: up.url }, candidates: media, contentType: 'detected', source: 'page-detected' } };
  const iframes = [...html.matchAll(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/gi)].map(m => abs(m[1], up.url)).filter(Boolean).slice(0, 8);
  const links = [...html.matchAll(/<a[^>]+href\s*=\s*["']([^"']+)["']/gi)].map(m => abs(m[1], up.url)).filter(x => { try { return x && isTeraHost(new URL(x).hostname); } catch { return false; } }).slice(0, 12);
  return { kind: 'page', url: up.url, candidates: [], iframes, links };
};

const sendError = (res, err, fallback) => {
  if (res.headersSent) return res.destroy();
  if (err instanceof BlockedError) return res.status(400).send(err.message || 'URL not allowed');
  res.status(502).send(fallback);
};

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'StreamVG', time: new Date().toISOString() }));

app.get('/api/resolve', allowApi, limited(resolveLimit), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  try {
    const target = req.query.url;
    if (!target || typeof target !== 'string') return res.status(400).json({ error: 'Missing url' });
    let u;
    try { u = new URL(target); } catch { return res.status(400).json({ error: 'Invalid url' }); }
    if (!['http:', 'https:'].includes(u.protocol)) return res.status(400).json({ error: 'URL not allowed' });
    await assertPublicHost(u.hostname);
    if (isTeraHost(u.hostname)) { const tera = await resolveTeraExternal(target); if (tera?.url) return relayed(res, tera); }

    // yt-dlp is thorough but can take ~25s; the plain page scan usually takes a second or two.
    // Run both. A quick yt-dlp answer wins; otherwise take the page scan instead of making the viewer wait.
    const abortExtractor = new AbortController();
    const extractor = runUniversalExtractor(target, abortExtractor.signal);
    const pageScan = inspectPage(u.href).catch(err => ({ failure: err }));
    const early = await Promise.race([extractor, wait(6000).then(() => 'slow')]);
    if (early && early !== 'slow' && early.url) { return relayed(res, early); }
    const page = await pageScan;
    if (page.failure instanceof BlockedError) { abortExtractor.abort(); return res.status(400).json({ error: 'Redirect target not allowed' }); }
    if (page.kind === 'media' && page.found) { abortExtractor.abort(); return relayed(res, page.found); }
    if (page.kind === 'media') { abortExtractor.abort(); return res.json(page); }
    const late = early === 'slow' ? await extractor : null;
    if (late?.url) return relayed(res, late);
    if (page.failure) return res.status(502).json({ error: 'Could not inspect this URL' });
    if (page.status) return res.status(page.status).json({ error: page.error });
    return res.json(page);
  } catch (err) {
    if (err instanceof BlockedError) return res.status(400).json({ error: 'URL not allowed' });
    res.status(502).json({ error: 'Could not inspect this URL' });
  }
});

const upstreamHeaders = (req, base = {}) => {
  const headers = { ...base };
  for (const key of Object.keys(headers)) if (/^(referer|referrer)$/i.test(key)) delete headers[key];
  for (const h of ['range', 'accept', 'accept-language']) { const v = req.headers[h]; if (v) headers[h] = v; }
  if (!headers['user-agent'] && !headers['User-Agent']) headers['user-agent'] = 'Mozilla/5.0 StreamVG Relay';
  return headers;
};

// Shared by /api/stream and /api/proxy: fetch upstream, rewrite playlists/manifests, or pipe the bytes through.
const relayUpstream = async (req, res, target, headers, { hrefFor, dashBase, onUrl }) => {
  const release = streamSlots.acquire(clientIp(req));
  if (!release) return res.status(429).send('Too many simultaneous streams.');
  res.on('close', release);
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    const up = await safeRequest(target.href, { headers, signal: abort.signal });
    const type = up.headers['content-type'] || '', finalPath = new URL(up.url).pathname;
    if (isM3u8(type, finalPath)) {
      const text = await readText(up.stream);
      return sendText(res, up.status, 'application/vnd.apple.mpegurl', rewriteM3u8(text, up.url, absolute => { onUrl?.(absolute); return hrefFor(absolute); }));
    }
    if (isMpd(type, finalPath)) {
      const text = await readText(up.stream, 4 * 1024 * 1024);
      return sendText(res, up.status, 'application/dash+xml', rewriteMpd(text, up.url, dir => dashBase(dir)));
    }
    sendUpstream(res, up);
  } catch (err) { if (!abort.signal.aborted) sendError(res, err, err instanceof BlockedError ? 'URL not allowed' : 'Relay error: upstream failure'); }
};

app.get('/api/stream/:token', allowApi, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const item = relayGet(req.params.token);
  if (!item) return res.status(410).send('Stream session expired. Resolve the URL again.');
  let target;
  try { target = new URL(typeof req.query.url === 'string' ? req.query.url : item.url); } catch { return res.status(400).send('Invalid url'); }
  if (typeof req.query.url === 'string' && !item.hosts.has(target.host)) return res.status(403).send('URL is not part of this stream');
  await relayUpstream(req, res, target, upstreamHeaders(req, item.headers), {
    hrefFor: absolute => '/api/stream/' + req.params.token + '?url=' + encodeURIComponent(absolute),
    dashBase: dir => '/api/proxy-path/' + b64u(dir) + '/',
    onUrl: absolute => { try { item.hosts.add(new URL(absolute).host); } catch {} },
  });
});

// Only the scheme is checked here; safeRequest() enforces that the host is public on every connection and redirect.
const parseHttpUrl = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u : null; } catch { return null; } };

app.get('/api/proxy', allowApi, async (req, res) => {
  const target = typeof req.query.url === 'string' ? parseHttpUrl(req.query.url) : null;
  if (!target) return res.status(400).send(req.query.url ? 'URL not allowed' : 'Missing url');
  const headers = {};
  for (const h of ['range', 'accept', 'accept-language', 'user-agent']) { const v = req.headers[h]; if (v) headers[h] = v; }
  await relayUpstream(req, res, target, headers, {
    hrefFor: absolute => '/api/proxy?url=' + encodeURIComponent(absolute),
    dashBase: dir => '/api/proxy-path/' + b64u(dir) + '/',
  });
});

// Segment/base-URL requests that the rewritten DASH manifests send: /api/proxy-path/<base64url dir>/<relative path>.
app.get('/api/proxy-path/:dir/*rest', allowApi, async (req, res) => {
  let target;
  try {
    const dir = unb64u(req.params.dir);
    if (!parseHttpUrl(dir)) throw new Error('bad dir');
    target = resolveProxyPath(dir, req.params.rest, req.originalUrl.split('?')[1] || '');
  } catch { return res.status(400).send('Invalid proxy path'); }
  const headers = {};
  for (const h of ['range', 'accept', 'accept-language', 'user-agent']) { const v = req.headers[h]; if (v) headers[h] = v; }
  await relayUpstream(req, res, target, headers, {
    hrefFor: absolute => '/api/proxy?url=' + encodeURIComponent(absolute),
    dashBase: dir => '/api/proxy-path/' + b64u(dir) + '/',
  });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(root));
app.use((req, res, next) => { if (req.method === 'GET') return res.sendFile(path.join(root, 'index.html')); next(); });

// ---- housekeeping & startup -------------------------------------------------------------------
setInterval(() => { const now = Date.now(); for (const [token, item] of localMediaStore) if (item.expires < now) localMediaCleanup(token); }, 60000).unref();
setInterval(() => { const now = Date.now(); for (const [k, v] of relayStore) if (v.expires < now) relayStore.delete(k); }, 60000).unref();

// Sessions live in memory, so anything left on disk by a previous process is unreachable: reclaim it.
await rm(LOCAL_MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
const port = process.env.PORT || 3000;
const server = createServer(app);
// Node's default requestTimeout (5 min) aborts any request whose body takes longer to arrive, which cuts
// off large local-file uploads on slow connections. Allow up to 30 minutes (or REQUEST_TIMEOUT_MS).
server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS) || 30 * 60 * 1000;
server.listen(port, () => console.log('StreamVG listening on ' + port));
