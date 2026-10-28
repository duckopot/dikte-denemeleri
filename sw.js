const V='dikte-v2';
const SHELL=['./','index.html','app.js','worker.js','style.css','audio-worklet.js','icon.svg','manifest.webmanifest',
 'vendor/transformers.min.js','vendor/ort-wasm-simd-threaded.jsep.mjs','vendor/ort-wasm-simd-threaded.jsep.wasm'];
// NOTE: model files live in Cache Storage caches "model-chunks-v1"/"model-small-v1" (written by worker.js) – never touched here,
// and their names must NOT start with "dikte-" (activate() deletes old dikte-* caches).
// Cross-origin isolation (SharedArrayBuffer => multi-thread WASM) on hosts without custom headers (GitHub Pages)
function iso(r){
  if(!r||r.status===0||r.type==='opaque')return r;
  const h=new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy','same-origin');
  h.set('Cross-Origin-Embedder-Policy','require-corp');
  h.set('Cross-Origin-Resource-Policy','same-origin');
  return new Response(r.body,{status:r.status,statusText:r.statusText,headers:h});
}
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>Promise.all(SHELL.map(u=>
  fetch(new Request(u,{cache:'reload'})).then(r=>{if(!r.ok)throw new Error(u+' '+r.status);return c.put(u,r)})))).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('dikte-')&&k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
const HEAVY=/\.(wasm|mjs)$|transformers\.min\.js$/;   // big, versioned by file name: cache-first
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin)return;   // model files: handled in worker.js
  e.respondWith((async()=>{
    const c=await caches.open(V);
    const cached=await c.match(e.request,{ignoreSearch:true});
    if(cached&&HEAVY.test(u.pathname))return iso(cached);
    // small files (html/js/css): network first so fixes reach the phone at once, cache = offline fallback
    try{
      const r=await fetch(e.request,{cache:'no-cache'});
      if(r.ok){c.put(e.request.url.split('?')[0],r.clone());return iso(r)}
      return iso(cached||r);
    }catch(err){ return iso(cached||await c.match('index.html')); }
  })());
});
