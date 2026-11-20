import test from 'node:test';
import assert from 'node:assert/strict';
import { clock, isTeraBox, srtToVtt, buildCodeSnippet, urlFromSearch, averageColor } from './utils.js';

test('srtToVtt converts timestamps, header and cue indexes (regression: doubled backslashes)', () => {
  const srt = '1\r\n00:00:01,000 --> 00:00:03,500\r\nHello\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,000\r\n42\r\n';
  const vtt = srtToVtt(srt);
  assert.ok(vtt.startsWith('WEBVTT\n\n'), 'real newlines in the header');
  assert.ok(!vtt.includes('\\n'), 'no literal backslash-n');
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:03.500'), 'comma -> dot');
  assert.ok(!/^1$/m.test(vtt) && !/^2$/m.test(vtt), 'cue indexes removed');
  assert.ok(/^42$/m.test(vtt), 'a subtitle line that is only a number is kept');
  assert.equal(vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nHello\n\n00:00:04.000 --> 00:00:05.000\n42\n');
});

test('srtToVtt keeps existing WebVTT, strips a BOM', () => {
  assert.equal(srtToVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n');
  assert.ok(srtToVtt('\uFEFF1\n00:00:01,000 --> 00:00:02,000\nHi').startsWith('WEBVTT\n\n00:00:01.000'));
});

test('isTeraBox strips www. and matches variants (regression: "\\\\." never matched)', () => {
  assert.ok(isTeraBox('https://www.terabox.com/s/1abc'));
  assert.ok(isTeraBox('https://1024terabox.com/s/1abc'));
  assert.ok(isTeraBox('https://www.4funbox.com/x'));
  assert.ok(isTeraBox('https://sub.terashare.me/x'));
  assert.ok(!isTeraBox('https://example.com/terabox'));
  assert.ok(!isTeraBox('not a url'));
});

test('buildCodeSnippet produces real line breaks and safe quoting', () => {
  const src = "https://cdn.example.com/it's/a.m3u8";
  const hls = buildCodeSnippet({ type: 'hls', source: src, share: 's' });
  assert.equal(hls.split('\n').length, 4);
  assert.ok(hls.includes('hls.loadSource("https://cdn.example.com/it\'s/a.m3u8");'));
  const vjs = buildCodeSnippet({ type: 'videojs', source: src, share: 's' });
  assert.ok(vjs.includes('application/x-mpegURL') && vjs.split('\n').length === 2);
  assert.ok(buildCodeSnippet({ type: 'videojs', source: 'https://x/a.mpd', share: 's' }).includes('application/dash+xml'));
  assert.ok(buildCodeSnippet({ type: 'videojs', source: 'https://x/a.mp4', share: 's' }).includes('video/mp4'));
  const ff = buildCodeSnippet({ type: 'ffmpeg', source: src, share: 's' });
  assert.equal(ff.split('\n').length, 2);
  assert.ok(ff.includes("'https://cdn.example.com/it'\\''s/a.m3u8'"), 'single quote escaped for the shell');
  const evil = buildCodeSnippet({ type: 'ffmpeg', source: 'https://x/$(touch pwned)`id`"', share: 's' });
  assert.ok(evil.includes("'https://x/$(touch pwned)`id`\"'"), 'shell metacharacters stay inside single quotes');
  assert.ok(buildCodeSnippet({ type: 'iframe', source: 'x', share: 'https://a/?url=%22' }).startsWith('<iframe src="https://a/?url=%22"'));
  assert.equal(buildCodeSnippet({ type: 'hls', source: '', share: '' }), 'Play a stream first.');
});

test('urlFromSearch accepts only http(s) URLs', () => {
  assert.equal(urlFromSearch('?url=' + encodeURIComponent('https://a.example/v.m3u8?x=1')), 'https://a.example/v.m3u8?x=1');
  assert.equal(urlFromSearch('?url=' + encodeURIComponent('javascript:alert(1)')), '');
  assert.equal(urlFromSearch('?url=nonsense'), '');
  assert.equal(urlFromSearch(''), '');
  assert.equal(urlFromSearch('?remote=abc'), '');
});

test('clock and averageColor', () => {
  assert.equal(clock(65), '01:05');
  assert.equal(clock(3725), '01:02:05');
  assert.equal(clock(NaN), '0:00');
  assert.equal(averageColor(new Uint8ClampedArray([0, 0, 0, 255, 100, 200, 50, 255])), '50,100,25');
  assert.equal(averageColor(new Uint8ClampedArray([])), null);
});
