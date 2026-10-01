import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

const execFileAsync=promisify(execFile);
const app=express();
const rate=new Map();
const relayStore=new Map();
const relay=(url,headers={})=>{const token=randomUUID();relayStore.set(token,{url,headers,expires:Date.now()+10*60*1000});return token};
const relayGet=token=>{const x=relayStore.get(token);if(!x||x.expires<Date.now()){relayStore.delete(token);return null}return x};
const RATE_WINDOW=60000;
const RATE_LIMIT=300;
const clientIp=req=>(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').toString().split(',')[0].trim();

const allowApi=(req,res,next)=>{
 const now=Date.now(),ip=clientIp(req),x=rate.get(ip)||{at:now,count:0};
 if(now-x.at>RATE_WINDOW){x.at=now;x.count=0}
 x.count++;rate.set(ip,x);
 if(x.count>RATE_LIMIT)return res.status(429).json({error:'Too many requests. Try again shortly.'});
 res.setHeader('Access-Control-Allow-Origin','https://streamvg.pages.dev');
 res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
 res.setHeader('Access-Control-Allow-Headers','Range,Content-Type');
 next();
};
app.use('/api',express.json({limit:'16kb'}));
app.options('/api/*splat',(req,res)=>{res.setHeader('Access-Control-Allow-Origin','https://streamvg.pages.dev');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Range,X-StreamVG-File-Name');res.sendStatus(204)});

const localMediaStore=new Map();
const LOCAL_MEDIA_TTL=30*60*1000;
const LOCAL_MEDIA_DIR='/tmp/streamvg-local';
const LOCAL_MEDIA_MAX=8*1024*1024*1024;

const localMediaCleanup=async token=>{
 const item=localMediaStore.get(token);
 if(!item)return;
 localMediaStore.delete(token);
 try{await unlink(item.path)}catch{}
};

app.post('/api/local-session',async(req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','https://streamvg.pages.dev');
 res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
 res.setHeader('Access-Control-Allow-Headers','Content-Type');
 const declared=Number(req.headers['content-length']||0);
 if(declared>LOCAL_MEDIA_MAX)return res.status(413).json({error:'Local file is too large for the server media engine.'});
 const token=randomUUID(),filePath=path.join(LOCAL_MEDIA_DIR,token+'.media');
 let bytes=0,tooLarge=false;
 const onData=chunk=>{bytes+=chunk.length;if(bytes>LOCAL_MEDIA_MAX){tooLarge=true;req.destroy(new Error('Local file exceeds the 8 GB server limit.'))}};
 req.on('data',onData);
 try{
  await mkdir(LOCAL_MEDIA_DIR,{recursive:true});
  await pipeline(req,createWriteStream(filePath));
  req.off('data',onData);
  if(tooLarge)throw new Error('Local file exceeds the 8 GB server limit.');
  console.log(JSON.stringify({event:'local-media-upload-complete',token,size:bytes}));
  const{stdout,stderr}=await execFileAsync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',filePath],{timeout:120000,maxBuffer:20*1024*1024});
  if(stderr)console.log(JSON.stringify({event:'local-media-probe-stderr',token,stderr:String(stderr).slice(-4000)}));
  const probe=JSON.parse(stdout||'{}');
  const streams=Array.isArray(probe.streams)?probe.streams:[];
  const audio=streams.filter(x=>x.codec_type==='audio').map((x,i)=>({i,index:x.index,codec:x.codec_name||'',codecLong:x.codec_long_name||'',language:x.tags?.language||x.tags?.language_ietf||'',title:x.tags?.title||x.tags?.handler_name||('Audio '+(i+1)),channels:x.channels||0,sampleRate:x.sample_rate||'',bitrate:x.bit_rate||''}));
  console.log(JSON.stringify({event:'local-media-audio-codecs',token,size:bytes,audio}));
  if(!audio.length){await unlink(filePath).catch(()=>{});return res.status(422).json({error:'No audio stream found in local media.',streams})}
  localMediaStore.set(token,{path:filePath,streams,expires:Date.now()+LOCAL_MEDIA_TTL});
  res.json({token,size:bytes,streams});
 }catch(err){
  req.off('data',onData);
  await unlink(filePath).catch(()=>{});
  console.error(JSON.stringify({event:'local-media-session-error',error:String(err?.stack||err)}));
  if(!res.headersSent)res.status(500).json({error:String(err?.message||'Local media session failed')});
 }
});

app.get('/api/local-audio/:token',async(req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','https://streamvg.pages.dev');
 res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
 const item=localMediaStore.get(req.params.token);
 if(!item||item.expires<Date.now()){if(item)await localMediaCleanup(req.params.token);return res.status(410).json({error:'Local media session expired.'})}
 const track=Number(req.query.track??0);
 const audio=item.streams.filter(x=>x.codec_type==='audio');
 if(!Number.isInteger(track)||track<0||track>=audio.length)return res.status(400).json({error:'Invalid audio track.'});
 const stream=audio[track],codec=String(stream.codec_name||'');
 console.log(JSON.stringify({event:'local-audio-extraction-start',token:req.params.token,track,codec}));
 const ff=spawn('ffmpeg',['-hide_banner','-loglevel','info','-i',item.path,'-map','0:a:'+track,'-vn','-c:a','aac','-b:a','192k','-movflags','+frag_keyframe+empty_moov+default_base_moof','-f','mp4','pipe:1'],{stdio:['ignore','pipe','pipe']});
 let stderr='';
 ff.stderr.on('data',chunk=>{stderr+=chunk.toString();if(stderr.length>12000)stderr=stderr.slice(-12000)});
 ff.once('error',err=>{console.error(JSON.stringify({event:'local-audio-extraction-error',token:req.params.token,track,codec,error:String(err?.stack||err)}));if(!res.headersSent)res.status(500).json({error:String(err?.message||'FFmpeg could not start')});else res.destroy(err)});
 ff.once('close',code=>{console.log(JSON.stringify({event:'local-audio-extraction-finished',token:req.params.token,track,codec,code,stderr:stderr.slice(-4000)}));if(code!==0&&!res.destroyed)res.destroy(new Error('FFmpeg audio extraction failed with code '+code))});
 res.statusCode=200;
 res.setHeader('Content-Type','audio/mp4');
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-StreamVG-Audio-Codec',codec);
 res.setHeader('X-StreamVG-Audio-Track',String(track));
 ff.stdout.pipe(res);
 req.on('close',()=>{if(!res.writableEnded&&!ff.killed)ff.kill('SIGTERM')});
});

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','dist');

const teraHosts=['terabox.com','terabox.app','teraboxshare.com','teraboxlink.com','teraboxurl.com','teraboxapp.com','terabox.club','terabox.link','teraboxfree.com','terafileshare.com','terasharefile.com','terasharelink.com','terashareus.com','1024terabox.com','1024tera.com','1024-terabox.com','tera1024box.com','momerybox.com','bestclouddrive.com','4funbox.in','4funbox.com','mirrobox.com','nephobox.com','pebibox.com','fancybox.in','gibibox.com','tibibox.com'];
const isTeraHost=h=>{const x=String(h||'').toLowerCase().replace(/^www\./,'');return teraHosts.includes(x)||x.includes('terabox')||x.includes('terafileshare')||x.includes('terashare')};
const TERABOX_NDUS=String(process.env.TERABOX_NDUS||'').trim();
const teraAuthHeaders=()=>TERABOX_NDUS?{cookie:'ndus='+TERABOX_NDUS}:{};

const runUniversalExtractor=async target=>{
 try{
  const ytArgs=['--dump-single-json','--no-playlist','--no-warnings','--skip-download','--no-js-runtimes','--js-runtimes','node','--remote-components','ejs:github','-f','best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best',target];
  const{stdout}=await execFileAsync('yt-dlp',ytArgs,{timeout:25000,maxBuffer:20*1024*1024});
  const d=JSON.parse(stdout),formats=Array.isArray(d.formats)?d.formats:[];
  const usable=formats.filter(x=>x?.url&&x.vcodec&&x.vcodec!=='none').sort((a,b)=>(b.height||0)-(a.height||0)||(b.tbr||0)-(a.tbr||0));
  const best=usable[0];
  if(best?.url)return{kind:'media',url:best.url,headers:{...(d.http_headers||{}),...(best.http_headers||{})},candidates:usable.slice(0,20).map(x=>({url:x.url,width:x.width,height:x.height,bitrate:x.tbr,codec:x.vcodec})),title:d.title||'',width:best.width,height:best.height,codec:best.vcodec,source:'universal-extractor'};
  if(d.url)return{kind:'media',url:d.url,headers:d.http_headers||{},title:d.title||'',width:d.width,height:d.height,codec:d.vcodec||'',source:'universal-extractor'};
  return null;
 }catch{return null}
};

const resolveTeraExternal=async target=>{
 const auth=teraAuthHeaders();
 const log=(stage,extra={})=>console.log(JSON.stringify({event:'terabox-resolve',stage,target:target.replace(/([?&](?:ndus|cookie|token|key)=)[^&]*/gi,'$1[redacted]'),hasNduCookie:Boolean(TERABOX_NDUS),...extra}));
 const candidates=[target];
 try{
  const page=await fetch(target,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 StreamVG Resolver',...auth},signal:AbortSignal.timeout(8000)});
   log('share-page',{status:page.status,finalUrl:page.url,ok:page.ok});
  if(page.ok){
   if(page.url&&page.url!==target)candidates.push(page.url);
   const html=(await page.text()).slice(0,1000000);
   for(const m of html.matchAll(/<(?:link|meta)[^>]+(?:rel|property)\\s*=\\s*["'](?:canonical|og:url)["'][^>]+(?:href|content)\\s*=\\s*["']([^"']+)["']/gi)){
    try{candidates.push(new URL(m[1],page.url).href)}catch{}
   }
  }
 }catch{}
 try{
  const u=new URL(target),parts=u.pathname.split('/').filter(Boolean),raw=parts[parts.length-1]||u.searchParams.get('surl');
  if(raw){
   const code=raw.startsWith('1')?raw.slice(1):raw;
   candidates.push('https://www.terabox.app/sharing/link?surl='+encodeURIComponent(code));
   candidates.push('https://terabox.com/sharing/link?surl='+encodeURIComponent(code));
   candidates.push('https://1024terabox.com/sharing/link?surl='+encodeURIComponent(code));
  }
 }catch{}
 const seen=new Set();
 for(const candidate of candidates){
  if(!candidate||seen.has(candidate))continue;seen.add(candidate);
  try{
   const form=new FormData();
   form.append('url',candidate);
   form.append('key','iTeraPlay2025');
   const r=await fetch('https://iteraplay.com/api/play.php',{method:'POST',body:form,headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36'},signal:AbortSignal.timeout(30000)});
   log('iteraplay',{candidate,status:r.status,ok:r.ok});
   if(r.ok){
    const d=await r.json(),v=d?.data||d;
    if(d?.error||d?.success===false)log('iteraplay-error',{candidate,error:String(d?.error||d?.message||d?.errmsg||'unknown').slice(0,300)});
    if(!v?.error&&d?.success!==false){
     const streams=v?.fast_stream_url||v?.stream_url||{};
     const urls=[streams.q_1080,streams.q_720,streams.q_480,streams.q_360,streams['1080'],streams['720'],streams['480'],streams['360'],v?.url,v?.streaming_url].filter(Boolean);
     if(urls[0])return{kind:'media',url:urls[0],headers:{'user-agent':'Mozilla/5.0 StreamVG Resolver','referer':'https://iteraplay.com/'},title:v?.title||v?.name||'TeraBox video',width:v?.width,height:v?.height,source:'iteraplay-resolver'};
    }
   }
  }catch{}
 }
 const headers={'user-agent':'Mozilla/5.0 StreamVG Resolver','accept':'application/json',...auth};
 for(const candidate of candidates){
  try{
   const r=await fetch('https://terabox-worker.robinkumarshakya103.workers.dev/api?url='+encodeURIComponent(candidate),{headers:{...headers,...auth},redirect:'follow',signal:AbortSignal.timeout(12000)});
   log('terabox-worker',{candidate,status:r.status,ok:r.ok});
   if(r.ok){
    const d=await r.json();
    if(d?.success===false||d?.error)log('terabox-worker-error',{candidate,error:String(d?.error||d?.message||d?.errmsg||'unknown').slice(0,300)});
    const f=d?.files?.find(x=>x?.streaming_url||x?.download_url)||d?.files?.[0],stream=f?.streaming_url||f?.download_url;
    if(stream)return{kind:'media',url:stream,headers:{...headers,referer:candidate},title:f?.file_name||f?.name||d?.title||'',width:f?.width,height:f?.height,source:'terabox-resolver'};
   }
  }catch{}
 }
 try{
  const u=new URL(target),parts=u.pathname.split('/').filter(Boolean),raw=parts[parts.length-1]||u.searchParams.get('surl');if(!raw)return null;
  const surl=raw.startsWith('1')?raw.slice(1):raw,base='https://tbx-proxy.shakir-ansarii075.workers.dev/';
  const rr=await fetch(base+'?mode=resolve&surl='+encodeURIComponent(surl)+'&refresh=1',{headers,redirect:'follow',signal:AbortSignal.timeout(12000)});
  log('tbx-resolve',{status:rr.status,ok:rr.ok});
  if(rr.ok){
   const sr=await fetch(base+'?mode=stream&surl='+encodeURIComponent(surl)+'&type=M3U8_AUTO_720',{headers:{...headers,accept:'application/vnd.apple.mpegurl,*/*'},redirect:'follow',signal:AbortSignal.timeout(12000)});
   log('tbx-stream',{status:sr.status,ok:sr.ok,contentType:sr.headers.get('content-type')||''});
   const type=sr.headers.get('content-type')||'';
   if(sr.ok&&(type.includes('mpegurl')||type.includes('m3u8')||type.includes('text/plain')))return{kind:'media',url:sr.url,headers:{...headers,referer:target},title:'TeraBox video',source:'terabox-hls-gateway'};
  }
 }catch{}
 log('failed',{reason:'all-resolvers-exhausted'});
 return null;
};

app.get('/api/health',(req,res)=>res.json({ok:true,service:'StreamVG',time:new Date().toISOString()}));

app.get('/api/resolve',allowApi,async(req,res)=>{
 res.setHeader('Cache-Control','no-store, no-cache, max-age=0, must-revalidate');
 try{
  const target=req.query.url;if(!target)return res.status(400).json({error:'Missing url'});
  const u=new URL(target);
  if(!['http:','https:'].includes(u.protocol)||await blockedHost(u.hostname))return res.status(400).json({error:'URL not allowed'});
  if(isTeraHost(u.hostname)){const tera=await resolveTeraExternal(target);if(tera?.url){const token=relay(tera.url,tera.headers);return res.json({...tera,url:API_PUBLIC+'/api/stream/'+token,originalUrl:tera.url,source:tera.source+'-relay'})}}
  const extracted=await runUniversalExtractor(target);
  if(extracted?.url){const token=relay(extracted.url,extracted.headers);return res.json({...extracted,url:API_PUBLIC+'/api/stream/'+token,originalUrl:extracted.url,source:extracted.source+'-relay'})}
  const r=await fetch(u,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 StreamVG Resolver','accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'}});
  const final=new URL(r.url);if(await blockedHost(final.hostname))return res.status(400).json({error:'Redirect target not allowed'});
  const type=r.headers.get('content-type')||'';
  if(type.startsWith('video/')||type.includes('mpegurl')||type.includes('dash'))return res.json({kind:'media',url:r.url,contentType:type});
  if(!type.includes('html')&&!type.includes('xml'))return res.status(415).json({error:'URL did not return a web page or supported media'});
  const html=(await r.text()).slice(0,5000000);
  const media=extractMedia(html,r.url);if(media.length){const token=relay(media[0],{'user-agent':'Mozilla/5.0 StreamVG Resolver','referer':r.url});return res.json({kind:'media',url:API_PUBLIC+'/api/stream/'+token,originalUrl:media[0],candidates:media,contentType:'detected',source:'page-detected-relay'})}
  const iframes=[...html.matchAll(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/gi)].map(m=>abs(m[1],r.url)).filter(Boolean).slice(0,8);
  const links=[...html.matchAll(/<a[^>]+href\s*=\s*["']([^"']+)["']/gi)].map(m=>abs(m[1],r.url)).filter(x=>{try{return x&&isTeraHost(new URL(x).hostname)}catch{return false}}).slice(0,12);
  return res.json({kind:'page',url:r.url,candidates:[],iframes,links});
 }catch{res.status(502).json({error:'Could not inspect this URL'})}
});

app.get('/api/stream/:token',allowApi,async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 try{
  const item=relayGet(req.params.token);if(!item)return res.status(410).send('Stream session expired. Resolve the URL again.');
  const target=req.query.url?new URL(req.query.url):new URL(item.url);
  if(!['http:','https:'].includes(target.protocol)||await blockedHost(target.hostname))return res.status(400).send('URL not allowed');
  const headers={...item.headers};delete headers.referer;delete headers.Referer;delete headers.referrer;delete headers.Referrer;for(const h of ['range','accept','accept-language']){const v=req.headers[h];if(v)headers[h]=v}if(!headers['user-agent']&&!headers['User-Agent'])headers['user-agent']='Mozilla/5.0 StreamVG Relay';
  const r=await fetch(target,{redirect:'follow',headers});const final=new URL(r.url);if(await blockedHost(final.hostname))return res.status(400).send('Redirect target not allowed');
  const type=r.headers.get('content-type')||'';
  if(type.includes('mpegurl')||target.pathname.toLowerCase().endsWith('.m3u8')){
   let text=await r.text();const base=new URL('.',r.url);text=text.split(/\r?\n/).map(line=>{if(!line||line.startsWith('#'))return line;try{return '/api/stream/'+req.params.token+'?url='+encodeURIComponent(new URL(line,base).href)}catch{return line}}).join('\n');
   res.status(r.status).setHeader('Content-Type','application/vnd.apple.mpegurl');res.setHeader('Access-Control-Allow-Origin','*');return res.send(text);
  }
  res.status(r.status);for(const h of ['content-type','content-length','content-range','accept-ranges','cache-control']){const v=r.headers.get(h);if(v)res.setHeader(h,v)}res.setHeader('Access-Control-Allow-Origin','*');if(r.body){for await(const chunk of r.body)res.write(chunk)}res.end();
 }catch(err){res.status(502).send('Relay error: '+(err?.message||'upstream failure'))}
});

app.get('/api/proxy',allowApi,async(req,res)=>{
 try{
  const target=req.query.url;if(!target)return res.status(400).send('Missing url');
  const u=new URL(target);if(!['http:','https:'].includes(u.protocol)||await blockedHost(u.hostname))return res.status(400).send('URL not allowed');
  const headers={};for(const h of ['range','accept','accept-language','user-agent']){const v=req.headers[h];if(v)headers[h]=v}
  const r=await fetch(u,{redirect:'follow',headers});const final=new URL(r.url);if(await blockedHost(final.hostname))return res.status(400).send('Redirect target not allowed');
  const type=r.headers.get('content-type')||'';
  if(type.includes('mpegurl')||u.pathname.toLowerCase().endsWith('.m3u8')){
   let text=await r.text();const base=new URL('.',r.url);
   text=text.split(/\r?\n/).map(line=>{if(!line||line.startsWith('#'))return line;try{return '/api/proxy?url='+encodeURIComponent(new URL(line,base).href)}catch{return line}}).join('\n');
   res.setHeader('Content-Type','application/vnd.apple.mpegurl');res.setHeader('Access-Control-Allow-Origin','*');return res.send(text);
  }
  res.status(r.status);for(const h of ['content-type','content-length','content-range','accept-ranges']){const v=r.headers.get(h);if(v)res.setHeader(h,v)}
  res.setHeader('Access-Control-Allow-Origin','*');if(r.body){for await(const chunk of r.body)res.write(chunk)}res.end();
 }catch{res.status(502).send('Proxy error')}
});

app.use(express.static(root));
app.use((req,res,next)=>{if(req.method==='GET')return res.sendFile(path.join(root,'index.html'));next()});

const blockedHost=async hostname=>{
 const h=hostname.toLowerCase();
 if(h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h.endsWith('.internal'))return true;
 try{
  const addrs=await lookup(h,{all:true});
  return addrs.some(x=>{const ip=x.address;return /^127\./.test(ip)||/^10\./.test(ip)||/^192\.168\./.test(ip)||/^169\.254\./.test(ip)||/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)||ip==='::1'||ip.startsWith('fc')||ip.startsWith('fd')||ip.startsWith('fe80:')});
 }catch{return true}
};

const abs=(x,base)=>{try{return new URL(x,base).href}catch{return null}};
const extractMedia=(html,base)=>{
 const out=new Set(),add=x=>{if(!x)return;const u=abs(x,base);if(!u)return;const l=u.toLowerCase();if(/\.(m3u8|mpd|mp4|webm|m4v|mov|ogv|ogg|mkv|ts)(?:[?#]|$)/i.test(l))out.add(u)};
 for(const m of html.matchAll(/<(?:video|source)[^>]+(?:src|data-src)\s*=\s*["']([^"']+)["']/gi))add(m[1]);
 for(const m of html.matchAll(/(?:og:video(?::secure_url)?|twitter:player:stream|contentUrl|contentURL)[^>]*?(?:content|contentUrl|contentURL)\s*=\s*["']([^"']+)["']/gi))add(m[1]);
 for(const m of html.matchAll(/["']((?:https?:)?\/\/[^"']+\.(?:m3u8|mpd|mp4|webm|m4v|mov|mkv|ts)(?:\?[^"']*)?)["']/gi))add(m[1]);
 return[...out];
};

setInterval(()=>{const now=Date.now();for(const[token,item]of localMediaStore)if(item.expires<now)localMediaCleanup(token)},60000).unref();
setInterval(()=>{const now=Date.now();for(const[k,v]of rate)if(now-v.at>RATE_WINDOW*2)rate.delete(k)},RATE_WINDOW*2).unref();
const API_PUBLIC=(process.env.PUBLIC_API_URL||'https://streamvg-web-production.up.railway.app').replace(/\/$/,'');
setInterval(()=>{const now=Date.now();for(const[k,v]of relayStore)if(v.expires<now)relayStore.delete(k)},60000).unref();
const port=process.env.PORT||3000;createServer(app).listen(port,()=>console.log('StreamVG listening on '+port));