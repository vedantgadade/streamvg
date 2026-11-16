// Browser compatibility planning shared by the remote-media API and tests.
// This is deliberately conservative: actual decode support still depends on browser/device.
const AUDIO_DIRECT = new Set(['aac','mp3','opus','vorbis']);
const VIDEO_DIRECT = new Set(['h264','av1','vp9']);
const AUDIO_TRANSCODE = new Set(['ac3','eac3','dts','dts_hd','truehd','mlp','flac','alac','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_s16be','pcm_s24be','pcm_s32be','pcm_u8']);
export function normalizeCodec(value='') { return String(value).trim().toLowerCase().replace(/^avc1(?:\\..*)?$/,'h264').replace(/^hev1(?:\\..*)?$/,'hevc').replace(/^hvc1(?:\\..*)?$/,'hevc').replace(/^av01(?:\\..*)?$/,'av1').replace(/^vp09(?:\\..*)?$/,'vp9'); }
export function planMediaCompatibility({formatName='',videoCodec='',audioCodecs=[]}={}) {
 const formats=String(formatName).toLowerCase().split(',');
 const containerNeedsRemux=formats.some(x=>['matroska','webm','avi','mpegts','mpeg'].includes(x));
 const video=normalizeCodec(videoCodec); const audio=(audioCodecs||[]).map(normalizeCodec);
 const transcodeVideo=!!video && !VIDEO_DIRECT.has(video);
 const transcodeAudio=audio.some(codec=>!AUDIO_DIRECT.has(codec) || AUDIO_TRANSCODE.has(codec)) || containerNeedsRemux;
 return {containerNeedsRemux,transcodeAudio,transcodeVideo,videoCodec:video,audioCodecs:audio,outputVideo:transcodeVideo?'h264':(video||'copy'),outputAudio:transcodeAudio?'aac':'copy'};
}
// Audio-only MP4 must fragment by duration/packet, not keyframes: it has no video keyframes.
export function buildRemoteAudioArgs(inputUrl,streamIndex,{bitrate='192k',channels=2,start=0}={}) {
 return ['-hide_banner','-loglevel','warning','-nostdin','-rw_timeout','20000000','-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','5','-i',inputUrl,'-map','0:'+Number(streamIndex),'-vn','-sn','-dn','-map_metadata','-1','-c:a','aac','-b:a',bitrate,'-ac',String(channels),'-af','aresample=async=1:first_pts=0','-movflags','+empty_moov+default_base_moof+frag_every_frame','-frag_duration','1000000','-flush_packets','1','-f','mp4','pipe:1'];
}
export function buildVideoFallbackArgs(inputUrl,videoIndex,audioIndex=null) {
 const args=['-hide_banner','-loglevel','warning','-nostdin','-rw_timeout','20000000','-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','5','-i',inputUrl,'-map','0:'+Number(videoIndex)];
 if(audioIndex!==null)args.push('-map','0:'+Number(audioIndex));else args.push('-an');
 args.push('-c:v','libx264','-preset','veryfast','-tune','zerolatency','-pix_fmt','yuv420p','-profile:v','high','-level:v','4.1','-c:a','aac','-b:a','192k','-ac','2','-movflags','+empty_moov+default_base_moof+frag_every_frame','-frag_duration','1000000','-flush_packets','1','-f','mp4','pipe:1'); return args;
}