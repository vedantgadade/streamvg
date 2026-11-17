import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

let enginePromise;

async function getEngine(onProgress) {
  if (!enginePromise) {
    enginePromise = (async () => {
      const ffmpeg = new FFmpeg();
      ffmpeg.on('progress', ({ progress }) => onProgress?.(Math.max(0, Math.min(1, progress))));
      const base = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd';
      await ffmpeg.load({
        coreURL: await toBlobURL(base + '/ffmpeg-core.js', 'text/javascript'),
        wasmURL: await toBlobURL(base + '/ffmpeg-core.wasm', 'application/wasm'),
      });
      return ffmpeg;
    })().catch(error => {
      enginePromise = undefined;
      throw error;
    });
  }
  return enginePromise;
}

export async function transcodeForBrowser(file, onProgress) {
  const ffmpeg = await getEngine(onProgress);
  const input = 'input' + (file.name.match(/\.[a-z0-9]{1,8}$/i)?.[0] || '.bin');
  const output = 'streamvg-compatible.mp4';
  await ffmpeg.writeFile(input, await fetchFile(file));
  try {
    await ffmpeg.exec([
      '-i', input, '-map', '0:v:0?', '-map', '0:a:0?',
      '-sn', '-dn', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-b:a', '192k', '-movflags', '+faststart', output,
    ]);
    const data = await ffmpeg.readFile(output);
    return new Blob([data.buffer], { type: 'video/mp4' });
  } finally {
    await ffmpeg.deleteFile(input).catch(() => {});
    await ffmpeg.deleteFile(output).catch(() => {});
  }
}
