import React,{useEffect,useRef,useState}from'react';
let HlsLib=null;let dashLib=null;
import{Play,Pause,Upload,Maximize,PictureInPicture,Settings,Activity,Repeat2,Camera,History,Trash2,Link2,Code2,Info,Subtitles,Sun,Moon}from'lucide-react';
import SitePage from './pages.jsx';

const API_BASE=(import.meta.env.VITE_API_BASE_URL||'https://streamvg-web-production.up.railway.app').replace(/\/$/,'');
const HIST='streamvg-history';
const clock=s=>{if(!Number.isFinite(s))return'0:00';const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=Math.floor(s%60);return(h?String(h).padStart(2,'0')+':':'')+String(m).padStart(2,'0')+':'+String(x).padStart(2,'0')};
const escUrl=u=>API_BASE+'/api/proxy?url='+encodeURIComponent(u);const isTeraBox=u=>{try{return /(?:^|\\.)(?:terabox(?:\\.app|\\.com)|teraboxshare\\.com|teraboxlink\\.com|terafileshare\\.com|terasharefile\\.com|terasharelink\\.com|1024terabox\\.com|1024tera\\.com)$/i.test(new URL(u).hostname)}catch{return false}};const resolveTeraBox=async u=>{const x=new URL(u);let code=x.searchParams.get('surl')||'';if(!code){const m=x.pathname.match(/\\/s\\/([^/?#]+)/i);code=m?.[1]||''}code=code.replace(/^1/,'');if(!code)throw new Error('Invalid TeraBox share link');return 'https://tbx-proxy.shakir-ansarii075.workers.dev/?mode=stream&surl='+encodeURIComponent(code)+'&type=M3U8_AUTO_720'};const isYouTube=u=>{try{return /(?:youtube\\.com|youtu\\.be)$/i.test(new URL(u).hostname)}catch{return false}};const youtubeEmbed=u=>{const x=new URL(u);let id=x.searchParams.get('v')||'';if(!id){const m=x.pathname.match(/\\/(?:shorts|embed|live)\\/([^/?#]+)/i);id=m?.[1]||''}if(!id&&/youtu\\.be$/i.test(x.hostname))id=x.pathname.split('/').filter(Boolean)[0]||'';return id?'https://www.youtube.com/embed/'+encodeURIComponent(id)+'?autoplay=1&rel=0&modestbranding=1':null};

export default function App(){
 const video=useRef(null),file=useRef(null),subFile=useRef(null),hls=useRef(null),dash=useRef(null),sleepTimer=useRef(null);
 const [url,setUrl]=useState(new URLSearchParams(location.search).get('url')||'');
 const [source,setSource]=useState(''),[engine,setEngine]=useState(''),[playing,setPlaying]=useState(false),[resolving,setResolving]=useState(false),[embedSrc,setEmbedSrc]=useState('');
 const [time,setTime]=useState(0),[duration,setDuration]=useState(0),[levels,setLevels]=useState([]),[level,setLevel]=useState(-1);
 const [proxy,setProxy]=useState(false),[speed,setSpeed]=useState(1),[loop,setLoop]=useState({a:null,b:null});
 const [sleep,setSleep]=useState('Off'),[subtitle,setSubtitle]=useState(''),[tab,setTab]=useState('share'),[codeType,setCodeType]=useState('iframe'),[theater,setTheater]=useState(false),[dark,setDark]=useState(true);
 const [history,setHistory]=useState(()=>{try{return JSON.parse(localStorage.getItem(HIST)||'[]')}catch{return[]}});
 const [stats,setStats]=useState({resolution:'—',bitrate:'—',bandwidth:'—',buffer:'0.0s',dropped:0,codec:'—'});
 const [resume,setResume]=useState(null);

 useEffect(()=>{document.documentElement.dataset.theme=dark?'dark':'light'},[dark]);
 useEffect(()=>{const v=video.current;if(!v)return;
  const timeUpdate=()=>{setTime(v.currentTime);if(source)localStorage.setItem('streamvg-pos-'+source,String(v.currentTime));if(loop.a!=null&&loop.b!=null&&v.currentTime>=loop.b)v.currentTime=loop.a};
  const meta=()=>setDuration(v.duration||0);const play=()=>setPlaying(true);const pause=()=>setPlaying(false);
  v.addEventListener('timeupdate',timeUpdate);v.addEventListener('loadedmetadata',meta);v.addEventListener('play',play);v.addEventListener('pause',pause);
  return()=>{v.removeEventListener('timeupdate',timeUpdate);v.removeEventListener('loadedmetadata',meta);v.removeEventListener('play',play);v.removeEventListener('pause',pause)}
 },[source,loop]);
 useEffect(()=>{const id=setInterval(()=>{const v=video.current;if(!v)return;let b=0;if(v.buffered.length)b=Math.max(0,v.buffered.end(v.buffered.length-1)-v.currentTime);const q=v.getVideoPlaybackQuality?.();setStats(s=>({...s,buffer:b.toFixed(1)+'s',dropped:q?.droppedVideoFrames??s.dropped,resolution:v.videoWidth?(v.videoWidth+'×'+v.videoHeight):s.resolution}))},1000);return()=>clearInterval(id)},[]);

 const destroy=()=>{hls.current?.destroy();hls.current=null;if(dash.current){try{dash.current.reset()}catch{}}dash.current=null};
 const addHistory=u=>{let h=[{url:u,host:new URL(u).host,title:u.split('/').pop()||u,at:Date.now()},...history.filter(x=>x.url!==u)].slice(0,15);setHistory(h);localStorage.setItem(HIST,JSON.stringify(h))};

 const resolveUrl=async input=>{const direct=/\.(m3u8|mpd|mp4|webm|m4v|mov|ogv|ogg|mkv|ts)(?:[?#]|$)/i.test(input);if(direct)return input;setResolving(true);try{if(isTeraBox(input))return await resolveTeraBox(input);let current=input;const seen=new Set();for(let depth=0;depth<6;depth++){if(seen.has(current))break;seen.add(current);const r=await fetch(API_BASE+'/api/resolve?url='+encodeURIComponent(current));const d=await r.json();if(d.kind==='media'&&d.url)return d.url;const next=[...(d.links||[]),...(d.iframes||[])].find(x=>x&&!seen.has(x));if(!next)break;current=next;if(isTeraBox(current))return await resolveTeraBox(current)}throw new Error('No playable media found')}finally{setResolving(false)}};
 const load=async(input=url,fromHistory=false)=>{
  if(!input)return;setEmbedSrc('');try{new URL(input)}catch{alert('Please enter a valid video URL.');return}
  const original=input;let playable=input;
  if(isYouTube(input)){const e=youtubeEmbed(input);if(e){destroy();setSource(original);setLevels([]);setLevel(-1);setResume(null);setEmbedSrc(e);setEngine('YouTube Player');addHistory(original);window.history.pushState({},'',original.startsWith('blob:')?location.pathname:'?url='+encodeURIComponent(original));return}}
  try{playable=await resolveUrl(input)}catch{setEngine('Resolver • No playable media found');alert('StreamVG could not find playable media at this URL.');return}
  destroy();setSource(original);setLevels([]);setLevel(-1);setResume(null);
  const v=video.current;const actual=proxy?escUrl(playable):playable;const low=playable.toLowerCase();
  if(low.includes('.m3u8')){
   setEngine('HLS.js');
   const Hls=HlsLib||(HlsLib=(await import('hls.js')).default);
   if(Hls.isSupported()){const x=new Hls({enableWorker:true});hls.current=x;
    x.on(Hls.Events.MANIFEST_PARSED,(_,d)=>setLevels(d.levels.map((l,i)=>({i,height:l.height,width:l.width,bitrate:l.bitrate,codec:l.videoCodec||l.codecs||'—'}))));
    x.on(Hls.Events.LEVEL_SWITCHED,(_,d)=>{const l=x.levels[d.level];setLevel(d.level);setStats(s=>({...s,resolution:l?.width?(l.width+'×'+l.height):s.resolution,bitrate:l?.bitrate?((l.bitrate/1000000).toFixed(2)+' Mbps'):s.bitrate,bandwidth:x.bandwidthEstimate?((x.bandwidthEstimate/1000000).toFixed(2)+' Mbps'):s.bandwidth,codec:l?.videoCodec||l?.codecs||s.codec}))});
    x.loadSource(actual);x.attachMedia(v);
   }else if(v.canPlayType('application/vnd.apple.mpegurl'))v.src=actual;else{alert('HLS is not supported by this browser.');return}
  }else if(low.includes('.mpd')){
   setEngine('DASH.js');
   const dashjs=dashLib||(dashLib=(await import('dashjs')).default);
   const d=dashjs.MediaPlayer().create();dash.current=d;
   const readDash=()=>{try{
    const reps=d.getRepresentationsByTypeUnfiltered?.('video')||d.getRepresentationsByType('video')||[];
    setLevels(reps.map((r,i)=>({i,height:r.height,width:r.width,bitrate:r.bitrateInKbit?Math.round(r.bitrateInKbit*1000):(r.bandwidth||0),codec:r.codecs||r.codec||'—'})));
    const cur=d.getCurrentRepresentationForType('video');
    if(cur){const i=reps.findIndex(r=>r.id===cur.id);setLevel(i>=0?i:-1);setStats(s=>({...s,resolution:cur.width&&cur.height?(cur.width+'×'+cur.height):s.resolution,bitrate:cur.bitrateInKbit?((cur.bitrateInKbit/1000).toFixed(2)+' Mbps'):cur.bandwidth?((cur.bandwidth/1000000).toFixed(2)+' Mbps'):s.bitrate,codec:cur.codecs||cur.codec||s.codec}))}
   }catch(err){console.error('DASH representation read error',err)}};
   const onDashReady=()=>{readDash();setTimeout(readDash,500);setTimeout(()=>v.play().catch(()=>{}),0)};
   d.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED,onDashReady);
   d.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED,()=>{readDash()});
   d.on(dashjs.MediaPlayer.events.ERROR,e=>{console.error('DASH error',e);setEngine('DASH.js • Error')});
   try{d.initialize(v,actual,false)}catch(err){console.error(err);setEngine('DASH.js • Error');alert('DASH could not be loaded. The stream may be unsupported or unavailable.')}
  }else{setEngine(input.startsWith('blob:')?'HTML5 Local':'HTML5 Native');v.src=actual;v.play().catch(()=>{})}
  if(!original.startsWith('blob:'))addHistory(original);
  if(!fromHistory){const p=Number(localStorage.getItem('streamvg-pos-'+input)||0);if(p>5)setResume(p)}
  window.history.pushState({},'',original.startsWith('blob:')?location.pathname:'?url='+encodeURIComponent(original));
 };

 const localPlay=f=>{if(!f)return;destroy();const u=URL.createObjectURL(f);setUrl('');setSource(u);setEngine('HTML5 Local');video.current.src=u;video.current.play().catch(()=>{})};
 const addSubtitle=f=>{if(!f)return;const r=new FileReader();r.onload=()=>{let t=String(r.result).replace(/\r/g,'');if(f.name.toLowerCase().endsWith('.srt')){t='WEBVTT\\n\\n'+t.replace(/(\\d{2}:\\d{2}:\\d{2}),(\\d{3})/g,'$1.$2').replace(/^\\d+\\s*\\n/gm,'')}const b=new Blob([t],{type:'text/vtt'});setSubtitle(URL.createObjectURL(b))};r.readAsText(f)};
 const screenshot=()=>{const v=video.current;if(!v.videoWidth)return;const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);const a=document.createElement('a');a.href=c.toDataURL('image/png');a.download='streamvg-screenshot.png';a.click()};
 const sleepChange=x=>{setSleep(x);clearTimeout(sleepTimer.current);if(x==='Custom'){const m=Number(prompt('Sleep timer minutes:', '90'));if(Number.isFinite(m)&&m>0)sleepTimer.current=setTimeout(()=>video.current?.pause(),m*60000);return}if(x!=='Off')sleepTimer.current=setTimeout(()=>video.current?.pause(),Number(x)*60000)};
 const codeSnippet=()=>{if(!source)return'Play a stream first.';if(codeType==='iframe')return '<iframe src="'+share+'" width="100%" height="500" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>';if(codeType==='hls')return "const video = document.querySelector('video');\\nconst hls = new Hls();\\nhls.loadSource('"+source.replace(/'/g,"\\\\'")+"');\\nhls.attachMedia(video);";if(codeType==='videojs')return "const player = videojs('streamvg-video');\\nplayer.src({src: '"+source.replace(/'/g,"\\\\'")+"', type: '"+(source.toLowerCase().includes('.m3u8')?'application/x-mpegURL':source.toLowerCase().includes('.mpd')?'application/dash+xml':'video/mp4')+"'});";return 'ffprobe -hide_banner "'+source+'"\\nffmpeg -i "'+source+'" -c copy output.mp4'};
 const share=location.origin+'/?url='+encodeURIComponent(source);

 return <div className="app">
  <header><div className="brand"><span>SV</span><div><b>StreamVG</b><small>Video Player & Stream Analyzer</small></div></div><button className="icon" onClick={()=>setDark(!dark)}>{dark?<Sun/>:<Moon/>}</button></header>
  <main>
   <section className="hero"><h1>Play. Analyze. Control.</h1><p>Paste almost any video URL — StreamVG automatically tries direct media, page extraction, embeds, and TeraBox links.</p>
    <div className="inputRow"><input value={url} onChange={e=>setUrl(e.target.value)} onKeyDown={e=>e.key==='Enter'&&load()} placeholder="Paste any video URL — page, Telegram, TeraBox, MP4, HLS or DASH"/><button className="primary" onClick={()=>load()} disabled={resolving}><Play/> {resolving?'Finding video…':'Play'}</button><button className="secondary" onClick={()=>file.current?.click()}><Upload/> Local</button><input ref={file} hidden type="file" accept="video/*" onChange={e=>localPlay(e.target.files[0])}/></div>
    <label className="toggle"><input type="checkbox" checked={proxy} onChange={e=>setProxy(e.target.checked)}/><span/>Use CORS proxy</label>
   </section>
   <section className={'playerCard'+(theater?' theater':'')}><div className="videoWrap">{embedSrc?<iframe src={embedSrc} title="StreamVG embedded video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen/>:<video ref={video} controls playsInline>{subtitle&&<track kind="subtitles" src={subtitle} default/>}</video>}</div>
    <div className="controls"><button onClick={()=>playing?video.current.pause():video.current.play()}>{playing?<Pause/>:<Play/>}</button><span>{clock(time)} / {clock(duration)}</span><input className="seek" type="range" min="0" max={duration||0} step=".1" value={time} onChange={e=>video.current.currentTime=Number(e.target.value)}/><select value={speed} onChange={e=>{let x=Number(e.target.value);setSpeed(x);video.current.playbackRate=x}}>{[.25,.5,.75,1,1.25,1.5,2,4,8,16].map(x=><option key={x} value={x}>{x}×</option>)}</select><button onClick={screenshot}><Camera/></button><button onClick={()=>video.current.requestPictureInPicture?.()}><PictureInPicture/></button><button onClick={()=>video.current.requestFullscreen?.()}><Maximize/></button><button onClick={()=>setTheater(!theater)} title="Theater mode">▣</button></div>
   </section>
   {resume!=null&&<div className="resume">Resume from {clock(resume)}? <button onClick={()=>{video.current.currentTime=resume;setResume(null)}}>Resume</button><button onClick={()=>setResume(null)}>Dismiss</button></div>}
   <section className="grid">
    <div className="panel"><div className="panelHead"><h2><Settings/> Quality & Tools</h2><span>{engine||'Waiting'}</span></div>
     <select value={level} onChange={e=>{let x=Number(e.target.value);setLevel(x);if(hls.current)hls.current.currentLevel=x;else if(dash.current){try{if(x<0)dash.current.updateSettings({streaming:{abr:{autoSwitchBitrate:{video:true}}}});else{dash.current.updateSettings({streaming:{abr:{autoSwitchBitrate:{video:false}}}});dash.current.setRepresentationForTypeByIndex('video',x,true)}}catch(err){console.error(err)}}}}><option value="-1">Auto (ABR)</option>{levels.map(l=><option key={l.i} value={l.i}>{l.height?l.height+'p':'Unknown'}{l.bitrate?' — '+(l.bitrate/1000000).toFixed(2)+' Mbps':''}</option>)}</select>
     <div className="tools"><button onClick={()=>setLoop({...loop,a:time})}><Repeat2/> Set A</button><button onClick={()=>setLoop({...loop,b:time})}>Set B</button><button onClick={()=>setLoop({a:null,b:null})}>Clear Loop</button></div>
     <div className="tools"><select value={sleep} onChange={e=>sleepChange(e.target.value)}><option>Off</option><option value="15">Sleep 15m</option><option value="30">Sleep 30m</option><option value="60">Sleep 60m</option><option value="Custom">Custom…</option></select><button onClick={()=>subFile.current?.click()}><Subtitles/> Add subtitles</button><input ref={subFile} hidden type="file" accept=".srt,.vtt" onChange={e=>addSubtitle(e.target.files[0])}/></div>
    </div>
    <div className="panel"><div className="panelHead"><h2><Activity/> Live Diagnostics</h2></div><div className="stats">{[['resolution','Resolution'],['bitrate','Bitrate'],['bandwidth','Bandwidth'],['buffer','Buffer'],['dropped','Dropped frames'],['codec','Codec']].map(a=><div key={a[0]}><b>{stats[a[0]]}</b><small>{a[1]}</small></div>)}</div></div>
   </section>
   <section className="panel wide"><div className="tabs"><button className={tab==='share'?'active':''} onClick={()=>setTab('share')}><Link2/> Share</button><button className={tab==='code'?'active':''} onClick={()=>setTab('code')}><Code2/> Embed</button><button className={tab==='history'?'active':''} onClick={()=>setTab('history')}><History/> History</button></div>
    {tab==='share'&&<div className="shareBox"><input readOnly value={source?share:''}/><button onClick={()=>source&&navigator.clipboard?.writeText(share)}>Copy</button></div>}
    {tab==='code'&&<div className="codeTools"><div className="codeTabs"><button className={codeType==='iframe'?'active':''} onClick={()=>setCodeType('iframe')}>iFrame</button><button className={codeType==='hls'?'active':''} onClick={()=>setCodeType('hls')}>HLS.js</button><button className={codeType==='videojs'?'active':''} onClick={()=>setCodeType('videojs')}>Video.js</button><button className={codeType==='ffmpeg'?'active':''} onClick={()=>setCodeType('ffmpeg')}>FFmpeg</button></div><div className="codeActions"><button onClick={()=>navigator.clipboard?.writeText(codeSnippet())}>Copy code</button></div><pre>{codeSnippet()}</pre></div>}
    {tab==='history'&&<div className="history">{history.length?history.map(x=><button className="historyItem" key={x.url} onClick={()=>{setUrl(x.url);load(x.url,true)}}><b>{x.host}</b><small>{x.url}</small></button>):<p>No recent streams.</p>}<button className="danger" onClick={()=>{setHistory([]);localStorage.removeItem(HIST)}}><Trash2/> Clear history</button></div>}
   </section>
   <div className="info"><Info/><div><b>About StreamVG</b><p>StreamVG accepts URLs without requiring them to be labeled public. It can only play media that the supplied URL and its available access actually expose; DRM or missing authentication cannot be unlocked by the player.</p></div></div>
  </main><footer>StreamVG • Free web video player • Use media you have permission to access.<nav><a href="/about/">About</a><a href="/faq/">FAQ</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a><a href="/copyright/">Copyright</a><a href="/contact/">Contact</a></nav></footer>
 </div>
}