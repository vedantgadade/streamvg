import React,{useEffect,useRef,useState} from 'react';
import { ArrowLeft, Play, Pause, Volume2, Maximize, Subtitles, Upload, Settings } from 'lucide-react';

export default function VlcPlayer({apiBase,initialUrl=''}) {
 const video=useRef(null),audio=useRef(null),file=useRef(null);
 const [url,setUrl]=useState(initialUrl),[active,setActive]=useState(''),[busy,setBusy]=useState(false),[status,setStatus]=useState('Ready'),[volume,setVolume]=useState(1),[muted,setMuted]=useState(false),[speed,setSpeed]=useState(1),[tracks,setTracks]=useState([]),[track,setTrack]=useState(-1),[token,setToken]=useState(''),[duration,setDuration]=useState(0),[time,setTime]=useState(0),[error,setError]=useState('');
 const cleanup=()=>{if(audio.current){audio.current.pause();audio.current.removeAttribute('src');audio.current.load()}if(video.current){video.current.pause();video.current.removeAttribute('src');video.current.load()}setActive('');setToken('');setTracks([]);setTrack(-1)};
 useEffect(()=>()=>cleanup(),[]);
 const playUrl=async(value)=>{
  if(!value)return;cleanup();setBusy(true);setError('');setStatus('Opening media…');
  try{
   const v=video.current;v.src=value;v.volume=volume;v.muted=false;await v.play().catch(()=>{});
   setActive(value);setStatus('Direct playback');
   try{
    const r=await fetch(apiBase+'/api/remote-media-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:value})});
    const d=await r.json();if(r.ok&&d.token){setToken(d.token);const a=(d.streams||[]).filter(x=>x.codec_type==='audio');setTracks(a.map((x,i)=>({i,label:x.title||x.language||('Audio '+(i+1)),codec:x.codec_name||'',lang:x.language||''})));setStatus(a.length+' audio track(s) detected')}
   }catch(e){console.warn('Track scan unavailable',e)}
  }catch(e){setError(e.message||'Could not open this media');setStatus('Playback failed')}finally{setBusy(false)}
 };
 const playFile=async(f)=>{
  if(!f)return;cleanup();setBusy(true);setError('');
  try{
   setStatus('Uploading to compatibility engine…');
   const r=await fetch(apiBase+'/api/local-session',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-StreamVG-File-Name':encodeURIComponent(f.name)},body:f});
   const d=await r.json();if(!r.ok)throw new Error(d.error||'Upload failed');setToken(d.token);
   setStatus('Converting video to browser-compatible H.264/AAC…');
   const tr=await fetch(apiBase+'/api/local-transcode/'+d.token,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
   const td=await tr.json();if(!tr.ok)throw new Error(td.error||'Transcode failed');
   const u=apiBase+td.url;video.current.src=u;video.current.volume=volume;await video.current.play().catch(()=>{});setActive(u);
   const aud=(d.streams||[]).filter(x=>x.codec_type==='audio');setTracks(aud.map((x,i)=>({i,label:x.tags?.title||x.tags?.language||('Audio '+(i+1)),codec:x.codec_name||'',lang:x.tags?.language||''})));
   setStatus('Compatible playback ready');
  }catch(e){setError(e.message||'Could not play this file');setStatus('Playback failed')}finally{setBusy(false)}
 };
 const selectTrack=async i=>{
  if(i<0||!token)return;const el=audio.current,v=video.current;if(!el||!v)return;setBusy(true);setStatus('Preparing audio track…');
  try{el.src=apiBase+'/api/local-audio/'+token+'?track='+i;el.load();await new Promise((ok,no)=>{el.oncanplay=ok;el.onerror=()=>no(new Error('Audio extraction failed'))});el.currentTime=v.currentTime;el.volume=muted?0:volume;el.playbackRate=speed;v.muted=true;if(!v.paused)await el.play();setTrack(i);setStatus('Audio track '+(i+1)+' active')}
  catch(e){v.muted=false;setError(e.message);setStatus('Audio track failed')}finally{setBusy(false)}
 };
 const setVol=x=>{const n=Number(x);setVolume(n);setMuted(n===0);if(audio.current&&track>=0){audio.current.volume=n;audio.current.muted=n===0}else if(video.current){video.current.volume=n;video.current.muted=n===0}};
 const seek=x=>{const n=Number(x);if(video.current)video.current.currentTime=n;if(audio.current&&track>=0)audio.current.currentTime=n;setTime(n)};
 return <div className="vlcMode" style={{minHeight:'100vh',background:'#111318',color:'#f4f4f5',padding:'24px',fontFamily:'inherit'}}>
  <style>{'.vlcMode button,.vlcMode input,.vlcMode select{font:inherit}.vlcMode button{cursor:pointer;border:1px solid #454951;background:#252930;color:#fff;border-radius:8px;padding:10px 14px}.vlcMode button:disabled{opacity:.5;cursor:wait}.vlcMode input[type=range]{accent-color:#ff8b24}.vlcMode .vlcTop{display:flex;align-items:center;justify-content:space-between;gap:12px;max-width:1100px;margin:0 auto 18px}.vlcMode .vlcStage{max-width:1100px;margin:auto;background:#000;border-radius:12px;overflow:hidden;box-shadow:0 18px 60px #0008}.vlcMode video{width:100%;max-height:68vh;display:block;background:#000}.vlcMode .vlcControls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px;background:#202329}.vlcMode .vlcControls input.seek{flex:1;min-width:130px}.vlcMode .vlcPanel{max-width:1100px;margin:18px auto;display:flex;gap:10px;flex-wrap:wrap}.vlcMode input[type=text]{background:#252930;border:1px solid #454951;border-radius:8px;padding:12px;color:white;flex:1;min-width:180px}.vlcMode .vlcStatus{max-width:1100px;margin:12px auto;color:#b7bbc4}.vlcMode .vlcError{color:#ff8d8d}.vlcMode .vlcTitle{font-size:24px;font-weight:700}.vlcMode label{display:flex;align-items:center;gap:8px}'}</style>
  <div className="vlcTop"><button onClick={()=>{location.href=location.origin+'/'}}><ArrowLeft size={16}/> Classic StreamVG</button><div className="vlcTitle">StreamVG · Media Player</div><button onClick={()=>file.current?.click()}><Upload size={16}/> Open file</button><input ref={file} hidden type="file" accept="video/*,.mkv,.avi,.mov,.webm,.ts,.m2ts" onChange={e=>playFile(e.target.files?.[0])}/></div>
  <div className="vlcPanel"><input type="text" value={url} onChange={e=>setUrl(e.target.value)} onKeyDown={e=>e.key==='Enter'&&playUrl(url)} placeholder="Paste a direct media URL"/><button disabled={busy} onClick={()=>playUrl(url)}><Play size={16}/> Open network stream</button></div>
  <div className="vlcStage"><video ref={video} playsInline onTimeUpdate={e=>setTime(e.currentTarget.currentTime)} onDurationChange={e=>setDuration(e.currentTarget.duration||0)} onEnded={()=>setStatus('Playback finished')}/><audio ref={audio} hidden/><div className="vlcControls"><button onClick={()=>video.current?.paused?video.current?.play():video.current?.pause()}>{video.current?.paused?<Play size={18}/>:<Pause size={18}/>}</button><Volume2 size={18}/><input aria-label="Volume" type="range" min="0" max="1" step=".01" value={muted?0:volume} onChange={e=>setVol(e.target.value)} style={{width:100}}/><span>{Math.floor(time/60)}:{String(Math.floor(time%60)).padStart(2,'0')}</span><input className="seek" aria-label="Seek" type="range" min="0" max={duration||0} step=".1" value={Math.min(time,duration||0)} onChange={e=>seek(e.target.value)}/><span>{Math.floor(duration/60)}:{String(Math.floor(duration%60)).padStart(2,'0')}</span><select value={speed} onChange={e=>{const n=Number(e.target.value);setSpeed(n);if(video.current)video.current.playbackRate=n;if(audio.current)audio.current.playbackRate=n}}><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select><button onClick={()=>video.current?.requestFullscreen?.()}><Maximize size={17}/></button></div></div>
  <div className="vlcPanel"><label><Subtitles size={17}/> Audio track <select value={track} onChange={e=>selectTrack(Number(e.target.value))}><option value="-1">Original / automatic</option>{tracks.map(t=><option key={t.i} value={t.i}>{t.label}{t.codec?' · '+t.codec:''}</option>)}</select></label><button onClick={()=>{if(video.current){video.current.muted=false;setMuted(false);setVol(volume||1)}}}>Restore original audio</button><button onClick={cleanup}>Stop</button></div>
  <div className={'vlcStatus'+(error?' vlcError':'')}>{busy?'Processing… ':''}{error||status}</div>
  <div className="vlcStatus">Separate player mode. Local files use the server FFmpeg H.264/AAC conversion path. Network URLs use browser playback with optional server-extracted audio tracks.</div>
 </div>;
}
