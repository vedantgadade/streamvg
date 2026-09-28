import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

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
app.options('/api/*splat',(req,res)=>res.sendStatus(204));

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','dist');

const teraHosts=['terabox.com','terabox.app','teraboxshare.com','teraboxlink.com','teraboxurl.com','teraboxapp.com','terabox.club','terabox.link','teraboxfree.com','terafileshare.com','terasharefile.com','terasharelink.com','terashareus.com','1024terabox.com','1024tera.com','1024-terabox.com','tera1024box.com','momerybox.com','bestclouddrive.com','4funbox.in','4funbox.com','mirrobox.com','nephobox.com','pebibox.com','fancybox.in','gibibox.com','tibibox.com'];
const isTeraHost=h=>{const x=String(h||'').toLowerCase().replace(/^www\./,'');return teraHosts.includes(x)||x.includes('terabox')||x.includes('terafileshare')||x.includes('terashare')};

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
 try{
  const r=await fetch('https://terabox-worker.robinkumarshakya103.workers.dev/api?url='+encodeURIComponent(target),{headers:{'user-agent':'Mozilla/5.0 StreamVG Resolver'},redirect:'follow'});
  if(!r.ok)return null;
  const d=await r.json(),f=d?.files?.find(x=>x?.streaming_url||x?.download_url)||d?.files?.[0];
  const u=f?.streaming_url||f?.download_url;
  return u?{kind:'media',url:u,headers:{'user-agent':'Mozilla/5.0 StreamVG Resolver','referer':target},title:f?.name||d?.title||'',width:f?.width,height:f?.height,source:'terabox-resolver'}:null;
 }catch{return null}
};

app.get('/api/health',(req,res)=>res.json({ok:true,service:'StreamVG',time:new Date().toISOString()}));

app.get('/api/resolve',allowApi,async(req,res)=>{
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
 try{
  const item=relayGet(req.params.token);if(!item)return res.status(410).send('Stream session expired. Resolve the URL again.');
  const target=req.query.url?new URL(req.query.url):new URL(item.url);
  if(!['http:','https:'].includes(target.protocol)||await blockedHost(target.hostname))return res.status(400).send('URL not allowed');
  const headers={...item.headers};for(const h of ['range','accept','accept-language']){const v=req.headers[h];if(v)headers[h]=v}if(!headers['user-agent']&&!headers['User-Agent'])headers['user-agent']='Mozilla/5.0 StreamVG Relay';
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

setInterval(()=>{const now=Date.now();for(const[k,v]of rate)if(now-v.at>RATE_WINDOW*2)rate.delete(k)},RATE_WINDOW*2).unref();
const API_PUBLIC=(process.env.PUBLIC_API_URL||'https://streamvg-web-production.up.railway.app').replace(/\/$/,'');
setInterval(()=>{const now=Date.now();for(const[k,v]of relayStore)if(v.expires<now)relayStore.delete(k)},60000).unref();
const port=process.env.PORT||3000;createServer(app).listen(port,()=>console.log('StreamVG listening on '+port));