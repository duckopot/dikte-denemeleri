const V='dikte-v1';
const SHELL=['./','index.html','app.js','worker.js','style.css','audio-worklet.js','icon.svg','manifest.webmanifest',
 'vendor/transformers.min.js','vendor/ort-wasm-simd-threaded.jsep.mjs','vendor/ort-wasm-simd-threaded.jsep.wasm'];
// Cross-origin isolation (SharedArrayBuffer => multi-thread WASM) on hosts without custom headers (GitHub Pages)
function iso(r){
  if(!r||r.status===0||r.type==='opaque')return r;
  const h=new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy','same-origin');
  h.set('Cross-Origin-Embedder-Policy','require-corp');
  h.set('Cross-Origin-Resource-Policy','same-origin');
  return new Response(r.body,{status:r.status,statusText:r.statusText,headers:h});
}
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('dikte-')&&k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin)return; // model files are handled by transformers.js (Cache API)
  e.respondWith((async()=>{
    const c=await caches.open(V);
    let r=await c.match(e.request,{ignoreSearch:true});
    if(!r){try{r=await fetch(e.request);if(r.ok)c.put(e.request,r.clone())}catch(err){r=await c.match('index.html')}}
    return iso(r);
  })());
});
