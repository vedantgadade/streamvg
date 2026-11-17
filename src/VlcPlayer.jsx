import React,{useEffect,useRef,useState} from 'react';
import Hls from 'hls.js';
import {ArrowLeft,Play,Pause,Volume2,Maximize,Upload,Subtitles,Settings,LoaderCircle,Film} from 'lucide-react';

export default function VlcPlayer({apiBase,initialUrl=''}) {
 const video=useRef(null),file=useRef(null),hls=useRef(null),request=useRef(0),session=useRef(null);
 const [url,setUrl]=useState(initialUrl),[busy,setBusy]=useState(false),[status,setStatus]=useState('Ready'),[volume,setVolume]=useState(1),[muted,setMuted]=useState(false),[speed,setSpeed]=useState(1),[tracks,setTracks]=useState([]),[track,setTrack]=useState(0),[duration,setDuration]=useState(0),[time,setTime]=useState(0),[error,setError]=useState(''),[playing,setPlaying]=useState(false);
 const stopSession=()=>{const old=session.current;session.current=null;if(old)fetch(apiBase+'/api/media-engine/'+old.kind+'/'+old.token+'/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>{})};
 const stop=()=>{request.current++;stopSession();if(hls.current){hls.current.destroy();hls.current=null}if(video.current){video.current.pause();video.current.removeAttribute('src');video.current.load()}session.current=null;setPlaying(false);setTime(0);setDuration(0)};
 useEffect(()=>{if(initialUrl)openNetwork(initialUrl);return()=>{stopSession();if(hls.current)hls.current.destroy();if(video.current){video.current.pause();video.current.removeAttribute('src')}}},[]);
 const startEngine=async(kind,token,audioTrack,streams,seq)=>{
  setStatus('FFmpeg is preparing a browser-compatible H.264/AAC stream…');
  const r=await fetch(apiBase+'/api/media-engine/'+kind+'/'+token+'/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({audioTrack})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error||'FFmpeg could not prepare this media');
  if(seq!==request.current)return;
  session.current={kind,token};
  const src=apiBase+d.url,v=video.current;
  if(!v)throw new Error('Player is not ready');
  v.volume=volume;v.muted=muted;v.playbackRate=speed;
  if(Hls.isSupported()){
   const engine=new Hls({enableWorker:true,lowLatencyMode:false,backBufferLength:90,manifestLoadingMaxRetry:4});
   hls.current=engine;
   engine.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal){setError('Stream error: '+(data.details||data.type));setStatus('Playback error')}});
   engine.on(Hls.Events.MANIFEST_PARSED,async()=>{if(seq!==request.current)return;setStatus('FFmpeg HLS stream ready');try{await v.play()}catch{setStatus('Ready — press Play to start')}});
   engine.loadSource(src);engine.attachMedia(v);
  }else if(v.canPlayType('application/vnd.apple.mpegurl')){
   v.src=src;v.load();setStatus('Native HLS stream ready');await v.play().catch(()=>{});
  }else throw new Error('This browser cannot play HLS streams.');
  setError('');
 };
 const openNetwork=async(value=url,audioTrack=0)=>{
  if(!value)return;
  const seq=++request.current;stopSession();setBusy(true);setError('');setStatus('Inspecting network media…');setTracks([]);setTrack(audioTrack);
  if(hls.current){hls.current.destroy();hls.current=null}
  if(video.current){video.current.pause();video.current.removeAttribute('src');video.current.load()}
  try{
   let parsed;try{parsed=new URL(value)}catch{throw new Error('Enter a complete http or https media URL.')}
   if(!['http:','https:'].includes(parsed.protocol))throw new Error('Only HTTP and HTTPS media sources are supported.');
   const r=await fetch(apiBase+'/api/remote-media-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:value})});
   const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Could not inspect this media source.');
   if(seq!==request.current)return;
   const aud=(d.streams||[]).filter(x=>x.codec_type==='audio');
   setTracks(aud.map((x,i)=>({i,label:x.title||x.language||('Audio '+(i+1)),codec:x.codec_name||'',lang:x.language||''})));
   if(aud.length===0)audioTrack=-1;else if(audioTrack>=aud.length)audioTrack=0;
   await startEngine('remote',d.token,audioTrack,aud,seq);
   setUrl(value);setStatus('Playing through FFmpeg compatibility engine');
  }catch(e){if(seq===request.current){setError(e.message||'Could not open this source');setStatus('Could not play media')}}finally{if(seq===request.current)setBusy(false)}
 };
 const openFile=async f=>{
  if(!f)return;
  const seq=++request.current;stopSession();setBusy(true);setError('');setStatus('Uploading file to the media engine…');setTracks([]);setTrack(0);
  if(hls.current){hls.current.destroy();hls.current=null}
  if(video.current){video.current.pause();video.current.removeAttribute('src');video.current.load()}
  try{
   const r=await fetch(apiBase+'/api/local-session',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-StreamVG-File-Name':encodeURIComponent(f.name)},body:f});
   const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Upload failed');
   if(seq!==request.current)return;
   const aud=(d.streams||[]).filter(x=>x.codec_type==='audio');
   setTracks(aud.map((x,i)=>({i,label:x.tags?.title||x.tags?.language||('Audio '+(i+1)),codec:x.codec_name||'',lang:x.tags?.language||''})));
   const selected=aud.length?0:-1;setTrack(selected);
   await startEngine('local',d.token,selected,aud,seq);
   session.current={kind:'local',token:d.token};setStatus('Local file playing through FFmpeg');
  }catch(e){if(seq===request.current){setError(e.message||'Could not open this file');setStatus('Could not play file')}}finally{if(seq===request.current)setBusy(false)}
 };
 const chooseTrack=async value=>{
  const next=Number(value);setTrack(next);
  if(!session.current)return;
  const current=session.current;
  if(current.kind==='remote')await openNetwork(url,next);
  else{
   const seq=++request.current;setBusy(true);setError('');
   if(hls.current){hls.current.destroy();hls.current=null}
   try{await startEngine('local',current.token,next,tracks,seq);setStatus('Audio track changed')}
   catch(e){setError(e.message);setStatus('Could not change audio track')}finally{if(seq===request.current)setBusy(false)}
  }
 };
 const setVol=x=>{const n=Number(x);setVolume(n);setMuted(n===0);if(video.current){video.current.volume=n;video.current.muted=n===0}};
 const seek=x=>{const n=Number(x);if(video.current&&Number.isFinite(n))video.current.currentTime=n;setTime(n)};
 const clock=n=>{if(!Number.isFinite(n))return'00:00';const h=Math.floor(n/3600),m=Math.floor(n%3600/60),s=Math.floor(n%60);return(h?String(h).padStart(2,'0')+':':'')+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')};
 return <div className="vlcMode" style={{minHeight:'100vh',background:'#101216',color:'#f4f4f5',padding:'clamp(12px,3vw,28px)',fontFamily:'inherit'}}>
  <style>{'.vlcMode button,.vlcMode input,.vlcMode select{font:inherit}.vlcMode button{cursor:pointer;border:1px solid #424750;background:#242a32;color:#fff;border-radius:9px;padding:10px 14px;display:inline-flex;align-items:center;gap:8px}.vlcMode button:disabled{opacity:.55;cursor:wait}.vlcMode input[type=range]{accent-color:#ff8b24}.vlcMode .vlcTop{display:flex;align-items:center;justify-content:space-between;gap:12px;max-width:1180px;margin:0 auto 18px;flex-wrap:wrap}.vlcMode .vlcStage{max-width:1180px;margin:auto;background:#000;border-radius:14px;overflow:hidden;box-shadow:0 18px 60px #0008}.vlcMode video{width:100%;max-height:72vh;display:block;background:#000;aspect-ratio:16/9}.vlcMode .vlcControls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px;background:#20242b}.vlcMode .vlcControls input.seek{flex:1;min-width:120px}.vlcMode .vlcPanel{max-width:1180px;margin:18px auto;display:flex;gap:10px;flex-wrap:wrap;align-items:center}.vlcMode input[type=text]{background:#242a32;border:1px solid #424750;border-radius:9px;padding:12px;color:white;flex:1;min-width:200px}.vlcMode select{background:#242a32;color:#fff;border:1px solid #424750;border-radius:8px;padding:9px}.vlcMode .vlcStatus{max-width:1180px;margin:12px auto;color:#b7bbc4;display:flex;align-items:center;gap:8px}.vlcMode .vlcError{color:#ff9696}.vlcMode .vlcTitle{font-size:22px;font-weight:750;letter-spacing:.2px}.vlcMode label{display:flex;align-items:center;gap:8px}.vlcMode .spinner{animation:vgspin 1s linear infinite}@keyframes vgspin{to{transform:rotate(360deg)}}'}</style>
  <div className="vlcTop"><button onClick={()=>{location.href=location.origin+'/?player=classic'}}><ArrowLeft size={16}/> Classic StreamVG</button><div className="vlcTitle">StreamVG Media Engine</div><button onClick={()=>file.current?.click()}><Upload size={16}/> Open file</button><input ref={file} hidden type="file" accept="video/*,audio/*,.mkv,.avi,.mov,.webm,.ts,.m2ts,.flv,.wmv" onChange={e=>openFile(e.target.files?.[0])}/></div>
  <div className="vlcPanel"><input type="text" value={url} onChange={e=>setUrl(e.target.value)} onKeyDown={e=>e.key==='Enter'&&openNetwork(url)} placeholder="Paste a direct media URL"/><button disabled={busy||!url.trim()} onClick={()=>openNetwork(url)}><Play size={16}/> Play network media</button></div>
  <div className="vlcStage"><video ref={video} playsInline controls={false} onTimeUpdate={e=>setTime(e.currentTarget.currentTime)} onDurationChange={e=>setDuration(e.currentTarget.duration||0)} onEnded={()=>setStatus('Playback finished')} onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onError={()=>{if(!busy)setError('The media stream could not be decoded or the server stream ended.')}}/><div className="vlcControls"><button aria-label={playing?'Pause':'Play'} onClick={()=>video.current?.paused?video.current?.play():video.current?.pause()}>{playing?<Pause size={18}/>:<Play size={18}/>}</button><Volume2 size={18}/><input aria-label="Volume" type="range" min="0" max="1" step=".01" value={muted?0:volume} onChange={e=>setVol(e.target.value)} style={{width:100}}/><span>{clock(time)}</span><input className="seek" aria-label="Seek" type="range" min="0" max={duration||0} step=".1" value={Math.min(time,duration||0)} onChange={e=>seek(e.target.value)} disabled={!duration}/><span>{clock(duration)}</span><select aria-label="Playback speed" value={speed} onChange={e=>{const n=Number(e.target.value);setSpeed(n);if(video.current)video.current.playbackRate=n}}><option value=".5">0.5×</option><option value=".75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select><button aria-label="Fullscreen" onClick={()=>video.current?.requestFullscreen?.()}><Maximize size={17}/></button></div></div>
  <div className="vlcPanel"><label><Subtitles size={17}/> Audio track <select value={track} onChange={e=>chooseTrack(e.target.value)}><option value="-1">No audio</option>{tracks.map(t=><option key={t.i} value={t.i}>{t.label}{t.codec?' · '+t.codec:''}</option>)}</select></label><button onClick={stop}>Stop</button><button onClick={()=>file.current?.click()}><Film size={16}/> Open another file</button></div>
  <div className={'vlcStatus'+(error?' vlcError':'')}>{busy?<LoaderCircle className="spinner" size={17}/>:<Settings size={16}/>} {busy?'Processing… ':''}{error||status}</div>
  <div className="vlcStatus">All local files and network URLs are normalized by server-side FFmpeg to H.264 HLS. Actual format support depends on the FFmpeg build and source access. DRM-protected media is not supported.</div>
 </div>;
}
