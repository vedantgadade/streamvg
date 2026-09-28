import React,{useEffect,useRef,useState}from'react';
import{Play,Pause,Upload,Maximize,PictureInPicture,Settings,Activity,Repeat2,Camera,History,Trash2,Link2,Code2,Info,Subtitles,Sun,Moon,Sparkles,MonitorPlay,ExternalLink,Download,Film,Clapperboard,Volume2,ShieldCheck}from'lucide-react';
import SitePage from './pages.jsx';
let HlsLib=null;let dashLib=null;

const API_BASE=(import.meta.env.VITE_API_BASE_URL||'https://streamvg-web-production.up.railway.app').replace(/\/$/,'');
const HIST='streamvg-history';
const VGSAVE='https://vgsave.pages.dev/';
const clock=s=>{if(!Number.isFinite(s))return'0:00';const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=Math.floor(s%60);return(h?String(h).padStart(2,'0')+':':'')+String(m).padStart(2,'0')+':'+String(x).padStart(2,'0')};
const escUrl=u=>API_BASE+'/api/proxy?url='+encodeURIComponent(u);
const teraHosts=['terabox.com','terabox.app','teraboxshare.com','teraboxlink.com','teraboxurl.com','teraboxapp.com','terabox.club','terabox.link','teraboxfree.com','terafileshare.com','terasharefile.com','terasharelink.com','terashareus.com','1024terabox.com','1024tera.com','1024-terabox.com','tera1024box.com','momerybox.com','bestclouddrive.com','4funbox.in','4funbox.com','mirrobox.com','nephobox.com','pebibox.com','fancybox.in','gibibox.com','tibibox.com'];
const isTeraBox=u=>{try{const h=new URL(u).hostname.toLowerCase().replace(/^www\./,'');return teraHosts.includes(h)||h.includes('terabox')}catch{return false}};
const youtubeEmbed=u=>{try{const x=new URL(u);let id=x.searchParams.get('v')||'';const p=x.pathname.split('/').filter(Boolean);if(!id&&p.length>=2&&(p[0]==='shorts'||p[0]==='embed'||p[0]==='live'))id=p[1];if(!id&&x.hostname.toLowerCase()==='youtu.be')id=p[0]||'';return id?'https://www.youtube.com/embed/'+encodeURIComponent(id)+'?autoplay=1&rel=0&modestbranding=1':null}catch{return null}};

export default function App(){
 const video=useRef(null),file=useRef(null),subFile=useRef(null),hls=useRef(null),dash=useRef(null),sleepTimer=useRef(null);
 const [url,setUrl]=useState(new URLSearchParams(location.search).get('url')||'');
 const [source,setSource]=useState(''),[engine,setEngine]=useState(''),[playing,setPlaying]=useState(false),[resolving,setResolving]=useState(false),[embedSrc,setEmbedSrc]=useState('');
 const [time,setTime]=useState(0),[duration,setDuration]=useState(0),[levels,setLevels]=useState([]),[level,setLevel]=useState(-1);
 const [proxy,setProxy]=useState(false),[speed,setSpeed]=useState(1),[loop,setLoop]=useState({a:null,b:null});
 const [sleep,setSleep]=useState('Off'),[subtitle,setSubtitle]=useState(''),[tab,setTab]=useState('share'),[codeType,setCodeType]=useState('iframe');
 const [theater,setTheater]=useState(false),[cinema,setCinema]=useState(false),[ambient,setAmbient]=useState(false),[oled,setOled]=useState(true),[dark,setDark]=useState(true);
 const [history,setHistory]=useState(()=>{try{return JSON.parse(localStorage.getItem(HIST)||'[]')}catch{return[]}});
 const [stats,setStats]=useState({resolution:'—',bitrate:'—',bandwidth:'—',buffer:'0.0s',dropped:0,codec:'—',fps:'—',status:'Waiting'});
 const [resume,setResume]=useState(null);

 useEffect(()=>{document.documentElement.dataset.theme=dark?'dark':'light';document.documentElement.dataset.oled=dark&&oled?'true':'false';document.body.classList.toggle('cinemaActive',cinema)},[dark,oled,cinema]);
 useEffect(()=>{const v=video.current;if(!v)return;
  const timeUpdate=()=>{setTime(v.currentTime);if(source&&!source.startsWith('blob:'))localStorage.setItem('streamvg-pos-'+source,String(v.currentTime));if(loop.a!=null&&loop.b!=null&&v.currentTime>=loop.b)v.currentTime=loop.a};
  const meta=()=>{setDuration(v.duration||0);setStats(s=>({...s,resolution:v.videoWidth?(v.videoWidth+'×'+v.videoHeight):s.resolution,status:'Ready'}))};
  const play=()=>{setPlaying(true);setStats(s=>({...s,status:'Playing'}))};const pause=()=>{setPlaying(false);setStats(s=>({...s,status:'Paused'}))};
  const waiting=()=>setStats(s=>({...s,status:'Buffering'}));const playingEvent=()=>setStats(s=>({...s,status:'Playing'}));
  const resize=()=>setStats(s=>({...s,resolution:v.videoWidth?(v.videoWidth+'×'+v.videoHeight):s.resolution}));
  v.addEventListener('timeupdate',timeUpdate);v.addEventListener('loadedmetadata',meta);v.addEventListener('play',play);v.addEventListener('pause',pause);v.addEventListener('waiting',waiting);v.addEventListener('playing',playingEvent);v.addEventListener('resize',resize);
  return()=>{['timeupdate','loadedmetadata','play','pause','waiting','playing','resize'].forEach(e=>v.removeEventListener(e,{timeupdate,loadedmetadata:meta,play,pause,waiting,playing:playingEvent,resize}[e]))}
 },[source,loop]);

 useEffect(()=>{const onKey=e=>{if(e.target?.tagName==='INPUT'||e.target?.tagName==='SELECT'||e.target?.isContentEditable)return;const v=video.current;if(e.code==='Space'){e.preventDefault();v?.paused?v?.play():v?.pause()}if(e.key.toLowerCase()==='f')v?.requestFullscreen?.();if(e.key.toLowerCase()==='p')v?.requestPictureInPicture?.();if(e.key.toLowerCase()==='t')setTheater(x=>!x);if(e.key.toLowerCase()==='c')setCinema(x=>!x);if(e.key.toLowerCase()==='a')setAmbient(x=>!x)};window.addEventListener('keydown',onKey);
 const id=setInterval(()=>{const v=video.current;if(!v||embedSrc)return;let b=0;if(v.buffered.length)b=Math.max(0,v.buffered.end(v.buffered.length-1)-v.currentTime);const q=v.getVideoPlaybackQuality?.();const fps=q?.totalVideoFrames&&duration>0?(q.totalVideoFrames/duration).toFixed(1):null;setStats(s=>({...s,buffer:b.toFixed(1)+'s',dropped:q?.droppedVideoFrames??s.dropped,resolution:v.videoWidth?(v.videoWidth+'×'+v.videoHeight):s.resolution,fps:fps?fps+' fps':s.fps,bandwidth:s.bandwidth==='—'&&navigator.connection?.downlink?(Number(navigator.connection.downlink).toFixed(1)+' Mbps est.'):s.bandwidth}))},1000);
 return()=>{clearInterval(id);window.removeEventListener('keydown',onKey)}},[duration,embedSrc]);

 const destroy=()=>{hls.current?.destroy();hls.current=null;if(dash.current){try{dash.current.reset()}catch{}}dash.current=null};
 const addHistory=u=>{let h=[{url:u,host:new URL(u).host,title:u.split('/').pop()||u,at:Date.now()},...history.filter(x=>x.url!==u)].slice(0,15);setHistory(h);localStorage.setItem(HIST,JSON.stringify(h))};
 const resolveUrl=async input=>{const direct=/\.(m3u8|mpd|mp4|webm|m4v|mov|ogv|ogg|mkv|ts)(?:[?#]|$)/i.test(input);if(direct)return input;setResolving(true);try{let current=input;const seen=new Set();for(let depth=0;depth<6;depth++){if(seen.has(current))break;seen.add(current);const r=await fetch(API_BASE+'/api/resolve?url='+encodeURIComponent(current));const d=await r.json();if(d.kind==='media'&&d.url)return d.url;const next=[...(d.links||[]),...(d.iframes||[])].find(x=>x&&!seen.has(x));if(!next)break;current=next}throw new Error('No playable media found')}finally{setResolving(false)}};

 const load=async(input=url,fromHistory=false)=>{
  if(!input)return;setEmbedSrc('');try{new URL(input)}catch{alert('Please enter a valid video URL.');return}
  const original=input;let playable=input;
  try{playable=await resolveUrl(input)}
  catch{const e=isYouTube(input)&&youtubeEmbed(input);if(e){destroy();setSource(original);setLevels([]);setLevel(-1);setResume(null);setEmbedSrc(e);setEngine('YouTube fallback');setStats({resolution:'Embedded',bitrate:'—',bandwidth:'—',buffer:'—',dropped:'—',codec:'—',fps:'—',status:'Embedded player'});addHistory(original);window.history.pushState({},'', '?url='+encodeURIComponent(original));return}setEngine('Resolver • No playable media');alert('StreamVG could not find playable media at this URL.');return}
  destroy();setSource(original);setLevels([]);setLevel(-1);setResume(null);
  const v=video.current;const actual=proxy?escUrl(playable):playable;const low=playable.toLowerCase();
  if(low.includes('.m3u8')){
   setEngine('HLS.js • Adaptive streaming');
   const Hls=HlsLib||(HlsLib=(await import('hls.js')).default);
   if(Hls.isSupported()){const x=new Hls({enableWorker:true});hls.current=x;
    x.on(Hls.Events.MANIFEST_PARSED,(_,d)=>{setLevels(d.levels.map((l,i)=>({i,height:l.height,width:l.width,bitrate:l.bitrate,codec:l.videoCodec||l.codecs||'—'})));setStats(s=>({...s,status:'Ready',bandwidth:x.bandwidthEstimate?((x.bandwidthEstimate/1000000).toFixed(2)+' Mbps'):'Measuring…'}))});
    x.on(Hls.Events.LEVEL_SWITCHED,(_,d)=>{const l=x.levels[d.level];setLevel(d.level);setStats(s=>({...s,resolution:l?.width?(l.width+'×'+l.height):s.resolution,bitrate:l?.bitrate?((l.bitrate/1000000).toFixed(2)+' Mbps'):s.bitrate,bandwidth:x.bandwidthEstimate?((x.bandwidthEstimate/1000000).toFixed(2)+' Mbps'):s.bandwidth,codec:l?.videoCodec||l?.codecs||s.codec,status:'Playing'}))});
    x.on(Hls.Events.ERROR,(_,d)=>{if(d?.fatal)setStats(s=>({...s,status:'Stream error'}))});x.loadSource(actual);x.attachMedia(v);
   }else if(v.canPlayType('application/vnd.apple.mpegurl'))v.src=actual;else{alert('HLS is not supported by this browser.');return}
  }else if(low.includes('.mpd')){
   setEngine('DASH.js • Adaptive streaming');
   const dashjs=dashLib||(dashLib=(await import('dashjs')).default);const d=dashjs.MediaPlayer().create();dash.current=d;
   const readDash=()=>{try{const reps=d.getRepresentationsByTypeUnfiltered?.('video')||d.getRepresentationsByType('video')||[];setLevels(reps.map((r,i)=>({i,height:r.height,width:r.width,bitrate:r.bitrateInKbit?Math.round(r.bitrateInKbit*1000):(r.bandwidth||0),codec:r.codecs||r.codec||'—'})));const cur=d.getCurrentRepresentationForType('video');if(cur){const i=reps.findIndex(r=>r.id===cur.id);setLevel(i>=0?i:-1);setStats(s=>({...s,resolution:cur.width&&cur.height?(cur.width+'×'+cur.height):s.resolution,bitrate:cur.bitrateInKbit?((cur.bitrateInKbit/1000).toFixed(2)+' Mbps'):cur.bandwidth?((cur.bandwidth/1000000).toFixed(2)+' Mbps'):s.bitrate,codec:cur.codecs||cur.codec||s.codec,status:'Playing'}))}}catch(err){console.error(err)}};
   d.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED,()=>{readDash();setTimeout(readDash,500);setTimeout(()=>v.play().catch(()=>{}),0)});d.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED,readDash);d.on(dashjs.MediaPlayer.events.ERROR,()=>setStats(s=>({...s,status:'Stream error'})));try{d.initialize(v,actual,false)}catch{setStats(s=>({...s,status:'DASH error'}))}
  }else{setEngine(input.startsWith('blob:')?'HTML5 Local':'HTML5 Native');v.src=actual;v.play().catch(()=>{});setStats(s=>({...s,status:'Loading native video'}))}
  if(!original.startsWith('blob:'))addHistory(original);if(!fromHistory){const p=Number(localStorage.getItem('streamvg-pos-'+input)||0);if(p>5)setResume(p)}window.history.pushState({},'',original.startsWith('blob:')?location.pathname:'?url='+encodeURIComponent(original));
 };

 const localPlay=f=>{if(!f)return;destroy();const u=URL.createObjectURL(f);setUrl('');setSource(u);setEngine('HTML5 Local');setStats(s=>({...s,status:'Loading local file',bitrate:'—',bandwidth:'Local'}));video.current.src=u;video.current.play().catch(()=>{})};
 const addSubtitle=f=>{if(!f)return;const r=new FileReader();r.onload=()=>{let t=String(r.result).replace(/\r/g,'');if(f.name.toLowerCase().endsWith('.srt'))t='WEBVTT\\n\\n'+t.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g,'$1.$2').replace(/^\d+\s*\n/gm,'');const b=new Blob([t],{type:'text/vtt'});setSubtitle(URL.createObjectURL(b))};r.readAsText(f)};
 const screenshot=()=>{const v=video.current;if(!v.videoWidth)return;const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);const a=document.createElement('a');a.href=c.toDataURL('image/png');a.download='streamvg-screenshot.png';a.click()};
 const sleepChange=x=>{setSleep(x);clearTimeout(sleepTimer.current);if(x==='Custom'){const m=Number(prompt('Sleep timer minutes:','90'));if(Number.isFinite(m)&&m>0)sleepTimer.current=setTimeout(()=>video.current?.pause(),m*60000);return}if(x!=='Off')sleepTimer.current=setTimeout(()=>video.current?.pause(),Number(x)*60000)};
 const codeSnippet=()=>{if(!source)return'Play a stream first.';if(codeType==='iframe')return '<iframe src="'+share+'" width="100%" height="500" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>';if(codeType==='hls')return "const video = document.querySelector('video');\\nconst hls = new Hls();\\nhls.loadSource('"+source.replace(/'/g,"\\\\'")+"');\\nhls.attachMedia(video);";if(codeType==='videojs')return "const player = videojs('streamvg-video');\\nplayer.src({src: '"+source.replace(/'/g,"\\\\'")+"', type: '"+(source.toLowerCase().includes('.m3u8')?'application/x-mpegURL':source.toLowerCase().includes('.mpd')?'application/dash+xml':'video/mp4')+"'});";return 'ffprobe -hide_banner "'+source+'"\\nffmpeg -i "'+source+'" -c copy output.mp4'};
 const share=location.origin+'/?url='+encodeURIComponent(source);const downloadUrl=source?VGSAVE+'?url='+encodeURIComponent(source):VGSAVE;

 return <div className="app">
  <header className="topbar"><div className="brand"><span className="brandMark"><Film/></span><div><b>StreamVG</b><small>WEB CINEMA • PLAYER • ANALYZER</small></div></div><div className="headerActions"><button className="topButton" onClick={()=>setCinema(!cinema)}><Clapperboard/> {cinema?'Exit cinema':'Cinema'}</button><button className="icon" onClick={()=>setOled(!oled)} title="OLED mode"><Sparkles/></button><button className="icon" onClick={()=>setDark(!dark)}>{dark?<Sun/>:<Moon/>}</button></div></header>
  <main>
   <section className="hero">
    <div className="eyebrow"><span></span> STREAMVG / UNIVERSAL VIDEO PLAYER</div>
    <h1>Your browser.<br/><strong>Your cinema.</strong></h1>
    <p>Paste almost any video page or media URL. StreamVG resolves the source, plays it, and exposes the stream controls and diagnostics that the browser can actually measure.</p>
    <div className="inputRow"><div className="inputShell"><Link2/><input value={url} onChange={e=>setUrl(e.target.value)} onKeyDown={e=>e.key==='Enter'&&load()} placeholder="Paste a video URL, TeraBox share, YouTube, MP4, HLS or DASH"/></div><button className="primary" onClick={()=>load()} disabled={resolving}><Play/> {resolving?'RESOLVING':'PLAY NOW'}</button><button className="secondary" onClick={()=>file.current?.click()}><Upload/> LOCAL</button><input ref={file} hidden type="file" accept="video/*" onChange={e=>localPlay(e.target.files[0])}/></div>
    <div className="heroMeta"><span><ShieldCheck/> No upload required</span><span><Activity/> Live player telemetry</span><span><Clapperboard/> Cinema + theatre modes</span><label><input type="checkbox" checked={proxy} onChange={e=>setProxy(e.target.checked)}/> CORS proxy</label></div>
   </section>

   <section className={'playerCard'+(theater?' theater':'')+(ambient?' ambient':'')+(cinema?' cinemaPlayer':'')}>
    <div className="playerTop"><div><span className="liveDot"></span>{engine||'READY FOR PLAYBACK'}</div><div className="playerActions"><button onClick={()=>setCinema(!cinema)}>{cinema?'EXIT CINEMA':'CINEMA'}</button><button onClick={()=>setTheater(!theater)}>{theater?'STANDARD':'THEATRE'}</button>{source&&!embedSrc&&<a href={downloadUrl} target="_blank" rel="noreferrer" className="downloadTop"><Download/> DOWNLOAD</a>}</div></div>
    <div className="videoWrap">{embedSrc?<iframe src={embedSrc} title="StreamVG embedded video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen/>:<video ref={video} controls playsInline preload="metadata">{subtitle&&<track kind="subtitles" src={subtitle} default/>}</video>}</div>
    {!embedSrc&&<div className="controlRail"><button onClick={()=>playing?video.current.pause():video.current.play()}>{playing?<Pause/>:<Play/>}</button><span className="time">{clock(time)} / {clock(duration)}</span><input className="seek" type="range" min="0" max={duration||0} step=".1" value={time} onChange={e=>video.current.currentTime=Number(e.target.value)}/><select value={speed} onChange={e=>{const x=Number(e.target.value);setSpeed(x);video.current.playbackRate=x}}>{[.25,.5,.75,1,1.25,1.5,2,4,8,16].map(x=><option key={x} value={x}>{x}×</option>)}</select><button onClick={screenshot} title="Screenshot"><Camera/></button><button onClick={()=>video.current.requestPictureInPicture?.()} title="Picture in picture"><PictureInPicture/></button><button onClick={()=>video.current.requestFullscreen?.()} title="Fullscreen"><Maximize/></button><button onClick={()=>setAmbient(!ambient)} title="Ambient light"><Sparkles/></button></div>}
   </section>

   {source&&<section className="downloadPanel"><div><div className="downloadIcon"><Download/></div><div><b>Download this video</b><span>Send the currently playing URL to VGSAVE for download options.</span></div></div><a href={downloadUrl} target="_blank" rel="noreferrer">OPEN VGSAVE <ExternalLink/></a></section>}
   {resume!=null&&<div className="resume">Resume from <b>{clock(resume)}</b>?<button onClick={()=>{video.current.currentTime=resume;setResume(null)}}>RESUME</button><button onClick={()=>setResume(null)}>DISMISS</button></div>}

   <section className="dashboard">
    <div className="panel qualityPanel"><div className="panelHead"><div><span className="panelKicker">PLAYBACK</span><h2><Settings/> Quality & controls</h2></div><span className="engine">{engine||'Waiting'}</span></div>
     <select value={level} onChange={e=>{const x=Number(e.target.value);setLevel(x);if(hls.current)hls.current.currentLevel=x;else if(dash.current){try{if(x<0)dash.current.updateSettings({streaming:{abr:{autoSwitchBitrate:{video:true}}}});else{dash.current.updateSettings({streaming:{abr:{autoSwitchBitrate:{video:false}}}});dash.current.setRepresentationForTypeByIndex('video',x,true)}}catch(err){console.error(err)}}}}><option value="-1">AUTO • ADAPTIVE BITRATE</option>{levels.map(l=><option key={l.i} value={l.i}>{l.height?l.height+'p':'Unknown'}{l.bitrate?' • '+(l.bitrate/1000000).toFixed(2)+' Mbps':''}</option>)}</select>
     <div className="tools"><button onClick={()=>setLoop({...loop,a:time})}><Repeat2/> SET A</button><button onClick={()=>setLoop({...loop,b:time})}>SET B</button><button onClick={()=>setLoop({a:null,b:null})}>CLEAR LOOP</button></div>
     <div className="tools"><select value={sleep} onChange={e=>sleepChange(e.target.value)}><option>Off</option><option value="15">Sleep 15m</option><option value="30">Sleep 30m</option><option value="60">Sleep 60m</option><option value="Custom">Custom…</option></select><button onClick={()=>subFile.current?.click()}><Subtitles/> SUBTITLES</button><input ref={subFile} hidden type="file" accept=".srt,.vtt" onChange={e=>addSubtitle(e.target.files[0])}/></div>
    </div>

    <div className="panel diagnosticsPanel"><div className="panelHead"><div><span className="panelKicker">TELEMETRY</span><h2><Activity/> Live diagnostics</h2></div><span className="statusPill">{stats.status}</span></div><div className="stats">{[['resolution','Resolution'],['bitrate','Source bitrate'],['bandwidth','Bandwidth'],['buffer','Buffer'],['dropped','Dropped frames'],['codec','Codec'],['fps','Frame rate']].map(a=><div key={a[0]}><small>{a[1]}</small><b>{stats[a[0]]}</b></div>)}</div><p className="diagnosticNote">{embedSrc?'Embedded players cannot expose cross-origin telemetry. StreamVG diagnostics activate automatically when the source is resolved into the HTML5 video engine.':'Telemetry reads directly from the playing video element; HLS/DASH also expose their real rendition and bandwidth data.'}</p></div>
   </section>

   <section className="cinemaFeatures"><div><Clapperboard/><b>CINEMA MODE</b><span>Focus the player and dim the rest of the page.</span></div><div><MonitorPlay/><b>THEATRE MODE</b><span>Wide-screen player for a room-style viewing setup.</span></div><div><Activity/><b>LIVE TELEMETRY</b><span>Resolution, bitrate, buffer and dropped frames.</span></div><div><Download/><b>VGSAVE HANDOFF</b><span>Download the video currently playing.</span></div></section>

   <section className="panel wide"><div className="tabs"><button className={tab==='share'?'active':''} onClick={()=>setTab('share')}><Link2/> SHARE</button><button className={tab==='code'?'active':''} onClick={()=>setTab('code')}><Code2/> EMBED</button><button className={tab==='history'?'active':''} onClick={()=>setTab('history')}><History/> HISTORY</button></div>
    {tab==='share'&&<div className="shareBox"><input readOnly value={source?share:''}/><button onClick={()=>source&&navigator.clipboard?.writeText(share)}>COPY LINK</button></div>}
    {tab==='code'&&<div className="codeTools"><div className="codeTabs">{[['iframe','iFrame'],['hls','HLS.js'],['videojs','Video.js'],['ffmpeg','FFmpeg']].map(([k,l])=><button key={k} className={codeType===k?'active':''} onClick={()=>setCodeType(k)}>{l}</button>)}</div><div className="codeActions"><button onClick={()=>navigator.clipboard?.writeText(codeSnippet())}>COPY CODE</button></div><pre>{codeSnippet()}</pre></div>}
    {tab==='history'&&<div className="history">{history.length?history.map(x=><button className="historyItem" key={x.url} onClick={()=>{setUrl(x.url);load(x.url,true)}}><b>{x.host}</b><small>{x.url}</small></button>):<p>No recent streams.</p>}<button className="danger" onClick={()=>{setHistory([]);localStorage.removeItem(HIST)}}><Trash2/> CLEAR HISTORY</button></div>}
   </section>
   <div className="info"><Info/><div><b>StreamVG is a universal playback layer</b><p>It tries direct media, page extraction, embedded sources and TeraBox-compatible links. It cannot unlock passwords, missing authentication or DRM protection.</p></div></div>
  </main>
  <footer>STREAMVG • FREE WEB CINEMA • USE MEDIA YOU HAVE PERMISSION TO ACCESS<nav><a href="/about/">About</a><a href="/faq/">FAQ</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a><a href="/copyright/">Copyright</a><a href="/contact/">Contact</a></nav></footer>
 </div>
}