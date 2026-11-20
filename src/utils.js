// Pure helpers used by App.jsx (kept free of React/DOM so they can be unit tested).

export const clock = s => {
  if (!Number.isFinite(s)) return '0:00';
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = Math.floor(s % 60);
  return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0');
};

export const TERA_HOSTS = ['terabox.com', 'terabox.app', 'teraboxshare.com', 'teraboxlink.com', 'teraboxurl.com', 'teraboxapp.com', 'terabox.club', 'terabox.link', 'teraboxfree.com', 'terafileshare.com', 'terasharefile.com', 'terasharelink.com', 'terashareus.com', '1024terabox.com', '1024tera.com', '1024-terabox.com', 'tera1024box.com', 'momerybox.com', 'bestclouddrive.com', '4funbox.in', '4funbox.com', 'mirrobox.com', 'nephobox.com', 'pebibox.com', 'fancybox.in', 'gibibox.com', 'tibibox.com'];

export const isTeraBox = u => {
  try {
    const h = new URL(u).hostname.toLowerCase().replace(/^www\./, '');
    return TERA_HOSTS.includes(h) || h.includes('terabox') || h.includes('terashare');
  } catch { return false; }
};

/**
 * SubRip (.srt) -> WebVTT. (The previous inline version had doubled backslashes, so it matched literal
 * "\d" and "\n" text: timestamps kept their commas and the WEBVTT header was malformed, which made every
 * uploaded .srt fail to display.)
 */
export const srtToVtt = input => {
  const text = String(input).replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (/^WEBVTT/.test(text)) return text + '\n';
  const body = text
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    // drop the numeric cue index, but only when a timing line follows (a subtitle line that is just "42" stays)
    .replace(/^\d+[ \t]*\n(?=\d{2}:\d{2}:\d{2}\.\d{3}[ \t]*-->)/gm, '');
  return 'WEBVTT\n\n' + body + '\n';
};

const shellQuote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

/** Text shown in the "Embed" tab. */
export const buildCodeSnippet = ({ type, source, share }) => {
  if (!source) return 'Play a stream first.';
  if (type === 'iframe') return '<iframe src="' + String(share).replace(/"/g, '&quot;') + '" width="100%" height="500" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>';
  if (type === 'hls') return "const video = document.querySelector('video');\nconst hls = new Hls();\nhls.loadSource(" + JSON.stringify(source) + ");\nhls.attachMedia(video);";
  if (type === 'videojs') {
    const lower = source.toLowerCase();
    const mime = lower.includes('.m3u8') ? 'application/x-mpegURL' : lower.includes('.mpd') ? 'application/dash+xml' : 'video/mp4';
    return "const player = videojs('streamvg-video');\nplayer.src({ src: " + JSON.stringify(source) + ", type: " + JSON.stringify(mime) + " });";
  }
  return 'ffprobe -hide_banner ' + shellQuote(source) + '\nffmpeg -i ' + shellQuote(source) + ' -c copy output.mp4';
};

/** `?url=` of a StreamVG address, or '' when it is absent or not a usable http(s) URL. */
export const urlFromSearch = search => {
  const value = new URLSearchParams(search).get('url') || '';
  if (!value) return '';
  try { return /^https?:$/.test(new URL(value).protocol) ? value : ''; } catch { return ''; }
};

/** Average colour of RGBA pixel data as "r,g,b" (for the ambient glow). Returns null for an empty buffer. */
export const averageColor = data => {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i + 3 < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
  return n ? Math.round(r / n) + ',' + Math.round(g / n) + ',' + Math.round(b / n) : null;
};

/**
 * MIME type (with a codecs string) that asks the browser whether it can decode a probed video stream, or ''
 * when the codec is one no mainstream browser decodes (MPEG-2, VC-1, WMV, DivX/Xvid...).
 */
export const videoCodecMime = stream => {
  const codec = String(stream?.codec_name || '').toLowerCase(), pix = String(stream?.pix_fmt || '');
  const tenBit = /10|12/.test(pix);
  switch (codec) {
    case 'h264': return 'video/mp4; codecs="avc1.640028"';
    case 'hevc': case 'h265': return 'video/mp4; codecs="' + (tenBit ? 'hvc1.2.4.L153.B0' : 'hvc1.1.6.L153.B0') + '"';
    case 'vp9': return 'video/webm; codecs="' + (tenBit ? 'vp09.02.10.10' : 'vp09.00.10.08') + '"';
    case 'av1': return 'video/mp4; codecs="' + (tenBit ? 'av01.0.08M.10' : 'av01.0.08M.08') + '"';
    case 'vp8': return 'video/webm; codecs="vp8"';
    case 'theora': return 'video/ogg; codecs="theora"';
    case 'mpeg4': return 'video/mp4; codecs="mp4v.20.9"';
    default: return '';
  }
};

/** True when the browser (via `canPlay`, normally video.canPlayType) can decode the stream; unknown codecs count as false. */
export const canDecodeVideo = (stream, canPlay) => {
  const mime = videoCodecMime(stream);
  if (!mime) return false;
  try { return !!canPlay(mime); } catch { return true; }
};
