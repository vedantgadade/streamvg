import React from'react';import{createRoot}from'react-dom/client';import'./styles.css';

window.addEventListener('vite:preloadError',e=>{e.preventDefault();window.location.reload()});

const root=document.getElementById('root');
const showBootError=err=>{console.error(err);root.innerHTML='<div style="min-height:100vh;background:#050505;color:#f5f1e8;display:grid;place-items:center;padding:32px;font-family:system-ui,sans-serif;text-align:center"><div><h1 style="font-size:32px;margin:0 0 12px">StreamVG is updating</h1><p style="opacity:.7;max-width:520px">The latest player bundle could not be loaded. Refresh once to load the current version.</p><button onclick="location.reload()" style="margin-top:18px;padding:12px 20px;border:0;border-radius:10px;background:#f2d18b;color:#111;font-weight:700;cursor:pointer">REFRESH STREAMVG</button></div></div>'};

(async()=>{try{const{default:App}=await import('./App.jsx');createRoot(root).render(<App/>)}catch(err){showBootError(err)}})();
