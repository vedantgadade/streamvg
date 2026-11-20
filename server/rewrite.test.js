import test from 'node:test';
import assert from 'node:assert/strict';
import { b64u, unb64u, isM3u8, isMpd, rewriteM3u8, rewriteMpd, resolveProxyPath } from './rewrite.js';

const proxy = u => '/p?url=' + encodeURIComponent(u);

test('rewriteM3u8 rewrites URI lines and URI="" attributes in every tag type', () => {
  const src = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k1",IV=0x1',
    '#EXT-X-KEY:METHOD=NONE',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/en.m3u8"',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000,URI="iframes.m3u8"',
    '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"',
    '#EXTINF:4.0,',
    'seg-1.m4s',
    '',
    '#EXTINF:4.0,',
    '/abs/seg-2.m4s?x=1',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const out = rewriteM3u8(src, 'https://cdn.example.com/v/master.m3u8', proxy).split('\n');
  assert.equal(out[2], '#EXT-X-MAP:URI="' + proxy('https://cdn.example.com/v/init.mp4') + '",BYTERANGE="720@0"');
  assert.equal(out[3], '#EXT-X-KEY:METHOD=AES-128,URI="' + proxy('https://keys.example.com/k1') + '",IV=0x1');
  assert.equal(out[4], '#EXT-X-KEY:METHOD=NONE');
  assert.equal(out[5], '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="' + proxy('https://cdn.example.com/v/audio/en.m3u8') + '"');
  assert.equal(out[6], '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000,URI="' + proxy('https://cdn.example.com/v/iframes.m3u8') + '"');
  assert.equal(out[7], '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"');
  assert.equal(out[9], proxy('https://cdn.example.com/v/seg-1.m4s'));
  assert.equal(out[10], '');
  assert.equal(out[12], proxy('https://cdn.example.com/abs/seg-2.m4s?x=1'));
  assert.equal(out[13], '#EXT-X-ENDLIST');
});

test('rewriteM3u8 keeps CRLF-separated input working and reports hosts through the callback', () => {
  const seen = [];
  const out = rewriteM3u8('#EXTM3U\r\nhttps://a.example/x.ts\r\n', 'https://b.example/', u => { seen.push(new URL(u).host); return 'P'; });
  assert.equal(out, '#EXTM3U\nP\n');
  assert.deepEqual(seen, ['a.example']);
});

test('content type helpers', () => {
  assert.ok(isM3u8('application/vnd.apple.mpegurl', '/x'));
  assert.ok(isM3u8('', '/live/index.M3U8'));
  assert.ok(!isM3u8('video/mp4', '/a.mp4'));
  assert.ok(isMpd('application/dash+xml', '/x'));
  assert.ok(isMpd('', '/a/manifest.mpd'));
});

const base = dir => 'API/' + b64u(dir) + '/';

test('rewriteMpd inserts a proxied BaseURL when the manifest has none', () => {
  const mpd = '<MPD><Period><AdaptationSet><SegmentTemplate media="v-$Number$.m4s"/></AdaptationSet></Period></MPD>';
  const out = rewriteMpd(mpd, 'https://cdn.example.com/dash/manifest.mpd', base);
  assert.match(out, new RegExp('<MPD><BaseURL>' + base('https://cdn.example.com/dash/').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '</BaseURL><Period>'));
});

test('rewriteMpd resolves a relative top-level BaseURL and proxies absolute nested ones', () => {
  const mpd = '<MPD><BaseURL>media/</BaseURL><Period><BaseURL>https://other.example.com/p/</BaseURL><BaseURL>rel/</BaseURL></Period></MPD>';
  const out = rewriteMpd(mpd, 'https://cdn.example.com/dash/m.mpd', base);
  assert.ok(out.includes('<BaseURL>' + base('https://cdn.example.com/dash/media/') + '</BaseURL>'));
  assert.ok(out.includes('<BaseURL>' + base('https://other.example.com/p/') + '</BaseURL>'));
  assert.ok(out.includes('<BaseURL>rel/</BaseURL>'), 'nested relative BaseURL is left to resolve against its proxied parent');
});

test('rewriteMpd leaves a manifest without a Period untouched', () => {
  const mpd = '<MPD></MPD>';
  assert.equal(rewriteMpd(mpd, 'https://x.example/m.mpd', base), mpd);
});

test('b64u round trips and resolveProxyPath cannot escape the upstream host', () => {
  assert.equal(unb64u(b64u('https://a.example/d/é?x=1')), 'https://a.example/d/é?x=1');
  assert.equal(resolveProxyPath('https://a.example/dash/', ['seg', '1.m4s'], 'tok=1').href, 'https://a.example/dash/seg/1.m4s?tok=1');
  assert.equal(resolveProxyPath('https://a.example/dash/', '../up.m4s').href, 'https://a.example/up.m4s');
  // A protocol-relative looking tail must stay on the original host.
  assert.equal(resolveProxyPath('https://a.example/dash/', '/evil.example/x').host, 'a.example');
  assert.equal(resolveProxyPath('https://a.example/dash/', ['', 'evil.example', 'x']).host, 'a.example');
});
