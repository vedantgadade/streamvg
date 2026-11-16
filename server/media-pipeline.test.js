import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRemoteAudioArgs, buildVideoFallbackArgs, normalizeCodec, planMediaCompatibility } from './media-pipeline.js';

test('normalizes common codec identifiers',()=>{
 assert.equal(normalizeCodec('avc1.640028'),'h264');
 assert.equal(normalizeCodec('hev1.2.4.L120'),'hevc');
 assert.equal(normalizeCodec('av01.0.08M.08'),'av1');
});

test('keeps browser-friendly MP4 streams on direct-play path',()=>{
 const plan=planMediaCompatibility({formatName:'mov,mp4,m4a,3gp,3g2,mj2',videoCodec:'h264',audioCodecs:['aac']});
 assert.equal(plan.transcodeAudio,false); assert.equal(plan.transcodeVideo,false);
});

test('transcodes Dolby/DTS and Matroska audio to AAC',()=>{
 const plan=planMediaCompatibility({formatName:'matroska,webm',videoCodec:'hevc',audioCodecs:['eac3','dts']});
 assert.equal(plan.transcodeAudio,true); assert.equal(plan.transcodeVideo,true); assert.equal(plan.outputAudio,'aac'); assert.equal(plan.outputVideo,'h264');
});

test('transcodes FLAC/ALAC/PCM audio when browser compatibility is uncertain',()=>{
 for(const codec of ['flac','alac','pcm_s24le']) assert.equal(planMediaCompatibility({formatName:'mov,mp4',videoCodec:'h264',audioCodecs:[codec]}).transcodeAudio,true);
});

test('remote audio output fragments without relying on video keyframes',()=>{
 const args=buildRemoteAudioArgs('https://media.example/movie.mkv',4,{start:75.5});
 assert.ok(args.includes('+empty_moov+default_base_moof+frag_every_frame'));
 assert.ok(args.includes('-frag_duration')); assert.ok(args.includes('1000000'));
 assert.ok(args.includes('-ss')); assert.ok(args.includes('75.5'));
 assert.ok(args.includes('0:4')); assert.ok(args.includes('aac'));
});

test('video fallback emits browser-oriented H.264 fragmented MP4',()=>{
 const args=buildVideoFallbackArgs('https://media.example/movie.avi',2,3);
 assert.ok(args.includes('libx264')); assert.ok(args.includes('yuv420p')); assert.ok(args.includes('0:2')); assert.ok(args.includes('0:3')); assert.ok(args.includes('frag_every_frame'));
});