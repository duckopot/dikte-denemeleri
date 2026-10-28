// Dikte worker – Whisper on-device (transformers.js 3.8.1 + onnxruntime-web).
// Memory strategy (see README): model files are downloaded in 8 MB Range chunks straight into Cache Storage
// (never held whole in JS memory), then read back exactly once, one file at a time, into ONNX Runtime.
import { pipeline, env } from './vendor/transformers.min.js';

const BUILD = '2026-10-28-m6';
const Q = new URL(self.location.href).searchParams;
const CHUNK = 8 * 1048576;
const CHUNK_CACHE = 'model-chunks-v1', SMALL_CACHE = 'model-small-v1', LEGACY_CACHE = 'transformers-cache';
// exact byte sizes from the Hugging Face tree API (onnx/ folder)
const MODELS = {
  turbo: { id: 'onnx-community/whisper-large-v3-turbo', sizes: {
  'onnx/encoder_model_q4f16.onnx': 369974078, 'onnx/decoder_model_merged_q4f16.onnx': 193505017,
  'onnx/encoder_model_q4.onnx': 424942775,    'onnx/decoder_model_merged_q4.onnx': 334147222,
  'onnx/encoder_model_bnb4.onnx': 385622743,  'onnx/decoder_model_merged_bnb4.onnx': 327594234,
  'onnx/encoder_model_int8.onnx': 644822094,  'onnx/decoder_model_merged_int8.onnx': 439936716,
  'onnx/encoder_model_fp16.onnx': 1274342603, 'onnx/decoder_model_merged_fp16.onnx': 344227339,
} },
  small: { id: 'onnx-community/whisper-small', sizes: {
    'onnx/encoder_model_q4.onnx': 66182104, 'onnx/decoder_model_merged_int8.onnx': 156750845,
    'onnx/encoder_model_int8.onnx': 92326127, 'onnx/decoder_model_merged_q4.onnx': 233149327,
  } },
};
let KEY = 'turbo', MODEL = MODELS.turbo.id, BASE = '', SIZES = {};
function setModel(k) { KEY = MODELS[k] ? k : 'turbo'; MODEL = MODELS[KEY].id; BASE = `https://huggingface.co/${MODEL}/resolve/main/`; SIZES = MODELS[KEY].sizes; }
setModel(Q.get('model') || 'turbo');
const SMALL_MB = 4;   // tokenizer.json etc. (~4 MB, fetched by transformers.js itself)

env.allowLocalModels = false;
env.useBrowserCache = false;
env.useCustomCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', self.location.href).href;   // no CDN

const post = (m) => self.postMessage(m);
const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let T = { device: '?', dtype: '?' };
const trace = (stage, extra = {}) => post({ type: 'trace', stage, ...T, ...extra });
self.addEventListener('error', (e) => { trace('worker-error', { err: String(e.message || e) }); post({ type: 'error', text: 'Worker: ' + (e.message || e) }); });
self.addEventListener('unhandledrejection', (e) => { const t = String((e.reason && e.reason.message) || e.reason); trace('worker-rejection', { err: t }); post({ type: 'error', text: 'Worker: ' + t }); });

// ---------------------------------------------------------------- download into Cache Storage (chunked, resumable)
const fileOf = (url) => url.startsWith(BASE) ? url.slice(BASE.length) : null;
const chunkKey = (file, size, i) => `${BASE}${file}?chunk=${i}&size=${size}`;
const nChunks = (size) => Math.ceil(size / CHUNK);

async function haveChunks(file, size) {
  const c = await caches.open(CHUNK_CACHE);
  const have = new Set((await c.keys()).map((r) => r.url));
  const out = [];
  for (let i = 0; i < nChunks(size); i++) if (have.has(chunkKey(file, size, i))) out.push(i);
  return out;
}
async function legacyHas(file) {
  try { return (await caches.has(LEGACY_CACHE)) && !!(await (await caches.open(LEGACY_CACHE)).match(BASE + file)); } catch (e) { return false; }
}

async function probe(file) {          // follow HF's 302 once to the CDN URL, learn the size, test Range support
  try {
    if (Q.get('norange')) throw new Error('norange (test)');
    const r = await fetch(BASE + file, { headers: { Range: 'bytes=0-0' } });
    const cr = r.headers.get('Content-Range');
    const total = cr ? +cr.split('/')[1] : null;
    try { await r.body.cancel(); } catch (e) {}
    return { url: r.url, ranged: r.status === 206 && !!total, total };
  } catch (e) { return { url: BASE + file, ranged: false, total: null, err: String(e) }; }
}

async function fetchRange(url, a, b, onBytes) {
  const r = await fetch(url, { headers: { Range: `bytes=${a}-${b}` } });
  if (r.status !== 206) throw new Error('HTTP ' + r.status);
  const want = b - a + 1, buf = new Uint8Array(want); let got = 0;
  try {
    const rd = r.body.getReader();
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      if (got + value.length > want) throw new Error('fazla veri');
      buf.set(value, got); got += value.length; onBytes(value.length);
    }
    if (got !== want) throw new Error(`eksik veri ${got}/${want}`);
  } catch (e) { onBytes(-got); throw e; }
  return buf;
}

async function downloadFile(file, prog) {
  let size = SIZES[file];
  if (!size) throw new Error('Bilinmeyen model dosyası: ' + file);
  const cache = await caches.open(CHUNK_CACHE);
  const have = new Set(await haveChunks(file, size));
  const missing = []; for (let i = 0; i < nChunks(size); i++) if (!have.has(i)) missing.push(i);
  for (const i of have) prog.add(Math.min(CHUNK, size - i * CHUNK), file);   // bytes already stored (resume)
  if (!missing.length) return;
  let pr = await probe(file);
  trace('indiriliyor', { file: file.replace('onnx/', ''), ranged: pr.ranged, missing: missing.length, resumed: have.size, err: pr.err });
  if (pr.total && pr.total !== size) throw new Error(`Boyut uyuşmazlığı ${file}: ${pr.total} != ${size}`);
  const put = async (i, buf) => cache.put(chunkKey(file, size, i), new Response(buf, { headers: { 'Content-Length': String(buf.length) } }));
  if (pr.ranged) {
    let next = 0, failed = null;
    const lane = async () => {
      while (next < missing.length && !failed) {
        const i = missing[next++], a = i * CHUNK, b = Math.min(size, a + CHUNK) - 1;
        for (let attempt = 0; ; attempt++) {
          try {
            const buf = await fetchRange(pr.url, a, b, (n) => prog.add(n, file));
            await put(i, buf); break;
          } catch (e) {
            if (attempt >= 4) { failed = e; return; }
            trace('indirme-tekrar', { file, chunk: i, err: String(e.message || e) });
            await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
            if (/403|401|HTTP 4/.test(String(e.message))) pr = { ...(await probe(file)) };
          }
        }
      }
    };
    await Promise.all([lane(), lane()]);
    if (failed) throw failed;
  } else {
    // no Range support (or CORS blocked it): one streaming GET, cut into 8 MB pieces on the fly
    const r = await fetch(BASE + file);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    prog.add(-prog.of(file), file);
    const rd = r.body.getReader(); let pend = [], pl = 0, idx = 0;
    const flush = async (final) => {
      while (pl >= CHUNK || (final && pl > 0)) {
        const n = Math.min(CHUNK, pl), out = new Uint8Array(n); let o = 0;
        while (o < n) { const h = pend[0], take = Math.min(h.length, n - o); out.set(h.subarray(0, take), o); o += take; if (take === h.length) pend.shift(); else pend[0] = h.subarray(take); }
        pl -= n; await put(idx++, out);
      }
    };
    for (;;) { const { done, value } = await rd.read(); if (done) break; pend.push(value); pl += value.length; prog.add(value.length, file); if (pl >= CHUNK) await flush(false); }
    await flush(true);
    if (idx !== nChunks(size)) throw new Error('Eksik indirme: ' + idx + '/' + nChunks(size) + ' parça');
  }
}

function assemble(file, size) {       // Response that streams the stored chunks back (read once by transformers.js)
  let i = 0;
  const n = nChunks(size);
  const body = new ReadableStream({
    async pull(ctrl) {
      if (i >= n) { ctrl.close(); return; }
      const c = await caches.open(CHUNK_CACHE);
      const r = await c.match(chunkKey(file, size, i++));
      if (!r) { ctrl.error(new Error('parça eksik: ' + (i - 1))); return; }
      ctrl.enqueue(new Uint8Array(await r.arrayBuffer()));
    },
  });
  return new Response(body, { headers: { 'Content-Length': String(size), 'Content-Type': 'application/octet-stream' } });
}

env.customCache = {
  async match(key) {
    const file = fileOf(key);
    if (file && SIZES[file]) {
      const size = SIZES[file];
      if ((await haveChunks(file, size)).length === nChunks(size)) return assemble(file, size);
      try { if (await caches.has(LEGACY_CACHE)) return await (await caches.open(LEGACY_CACHE)).match(key); } catch (e) {}
      return undefined;
    }
    return (await (await caches.open(SMALL_CACHE)).match(key)) || undefined;
  },
  async put(key, resp) {
    const file = fileOf(key);
    if (file && SIZES[file]) return;      // big files are only ever stored by downloadFile()
    await (await caches.open(SMALL_CACHE)).put(key, resp);
  },
};

// ---------------------------------------------------------------- config
async function gpuInfo() {
  try {
    if (!navigator.gpu) return null;
    const a = await navigator.gpu.requestAdapter(); if (!a) return null;
    return { f16: a.features.has('shader-f16'), maxBuf: a.limits.maxBufferSize, maxStor: a.limits.maxStorageBufferBindingSize };
  } catch (e) { return null; }
}
async function pickConfig(force) {
  if (KEY === 'small') {                                  // iPhone-friendly model: CPU/WASM (small weights, low memory)
    const cfg = { device: 'wasm', enc: Q.get('enc') || 'q4', dec: Q.get('dec') || 'int8', label: 'Small · WASM' };
    cfg.files = [`onnx/encoder_model_${cfg.enc}.onnx`, `onnx/decoder_model_merged_${cfg.dec}.onnx`];
    cfg.bytes = cfg.files.reduce((x, f) => x + (SIZES[f] || 0), 0); cfg.mb = Math.round(cfg.bytes / 1e6); cfg.gpu = null;
    return cfg;
  }
  const g = force === 'wasm' ? null : await gpuInfo();
  let cfg;
  if (g && g.f16)  cfg = { device: 'webgpu', enc: 'q4f16', dec: 'q4f16', label: 'WebGPU · q4f16' };
  else if (g)      cfg = { device: 'webgpu', enc: 'q4',    dec: 'q4',    label: 'WebGPU · q4' };
  else             cfg = { device: 'wasm',   enc: 'q4',    dec: 'q4',    label: 'WASM · q4' };
  if (force === 'webgpu' && !g) throw new Error('Bu cihazda WebGPU yok.');
  if (Q.get('hq') && g && g.f16) { cfg.enc = 'fp16'; cfg.dec = 'fp16'; cfg.label = 'WebGPU · fp16'; }   // ?hq=1: best quality on a desktop GPU (1.6 GB, untested on box: no GPU)
  if (Q.get('enc')) cfg.enc = Q.get('enc');
  if (Q.get('dec')) cfg.dec = Q.get('dec');
  if (Q.get('decdev') && cfg.device === 'webgpu') {                   // split: encoder on GPU, decoder on CPU (WASM)
    cfg.decdev = Q.get('decdev'); if (!Q.get('dec')) cfg.dec = 'q4';
    cfg.label = 'WebGPU ' + cfg.enc + ' + WASM ' + cfg.dec;
  }
  cfg.files = [`onnx/encoder_model_${cfg.enc}.onnx`, `onnx/decoder_model_merged_${cfg.dec}.onnx`];
  cfg.bytes = cfg.files.reduce((s, f) => s + (SIZES[f] || 0), 0);
  cfg.mb = Math.round(cfg.bytes / 1e6);
  cfg.gpu = g;
  return cfg;
}
function sessionOptions(cfg) {
  const o = { enableCpuMemArena: false, enableMemPattern: false };      // don't let ORT hoard arenas
  const xs = Q.get('xs');                                                // experiment: ORT session config keys, e.g. xs=disable_prepacking
  if (xs) { o.extra = { session: {} }; for (const k of xs.split(',')) o.extra.session[k] = '1'; }
  // 'disabled' = biggest single memory saver measured (-35% peak: ORT's graph optimizer makes extra copies of all weights); ~30% slower on CPU
  o.graphOptimizationLevel = Q.get('opt') || (iOS ? 'disabled' : 'all');   // desktop: full optimization (faster); iPhone: memory first                  // override: ?opt=basic|extended|all
  return o;
}
function setThreads(cfg) {
  let n;
  if (Q.get('thr')) n = +Q.get('thr');
  else if (cfg.device === 'webgpu' && !cfg.decdev) n = 1;                               // compute runs on the GPU
  else n = self.crossOriginIsolated ? Math.min(iOS ? 2 : 4, navigator.hardwareConcurrency || 2) : 1;
  env.backends.onnx.wasm.numThreads = n;
  return n;
}

// ---------------------------------------------------------------- load
let asr = null, info = null;
async function load(force) {
  if (asr) { post({ type: 'ready', ...info }); return; }
  trace('başlıyor', { build: BUILD, ios: iOS, model: KEY });
  let cfg = await pickConfig(force || Q.get('device'));
  T = { device: cfg.device + (cfg.decdev ? '+' + cfg.decdev : ''), dtype: cfg.enc + '/' + cfg.dec };
  trace('yapılandırma', { gpu: cfg.gpu, mb: cfg.mb, opt: Q.get('opt') || (iOS ? 'disabled' : 'all') });

  // 1) download (streams to Cache Storage; low memory, resumable)
  const prog = (() => {
    const per = {}; let tot = 0, last = 0;
    const emit = (file, force) => { const now = performance.now(); if (!force && now - last < 150) return; last = now; post({ type: 'progress', loaded: Math.max(0, Math.min(tot, cfg.bytes)), total: cfg.bytes, file }); };
    return { add(n, f = '') { tot += n; per[f] = (per[f] || 0) + n; emit(f); }, of: (f) => per[f] || 0 };
  })();
  for (const f of cfg.files) {
    if (await legacyHas(f)) { prog.add(SIZES[f], f); continue; }
    post({ type: 'status', text: 'İndiriliyor: ' + f.replace('onnx/', '') });
    await downloadFile(f, prog);
    trace('indirildi', { file: f });
  }
  post({ type: 'progress', loaded: cfg.bytes, total: cfg.bytes, file: '' });

  // 2) load into runtime – sequential (vendor patch), one file at a time
  const threads = setThreads(cfg);
  const cb = (p) => {
    if (!p.file) return;
    const short = p.file.replace('onnx/', '');
    if (p.status === 'initiate') { post({ type: 'status', text: 'Hazırlanıyor: ' + short }); trace('hazırlık', { file: short }); }
    else if (p.status === 'download' && /\.onnx$/.test(p.file)) { post({ type: 'status', text: 'Belleğe okunuyor: ' + short }); trace('belleğe-okuma', { file: short }); }
    else if (p.status === 'done' && /\.onnx$/.test(p.file)) { post({ type: 'status', text: 'Model oturumu kuruluyor: ' + short }); trace('oturum-kurma', { file: short }); }
  };
  const build = (c) => pipeline('automatic-speech-recognition', MODEL, {
    device: c.decdev ? { encoder_model: c.device, decoder_model_merged: c.decdev } : c.device, dtype: { encoder_model: c.enc, decoder_model_merged: c.dec }, session_options: sessionOptions(c), progress_callback: cb,
  });
  try {
    asr = await build(cfg);
  } catch (e) {
    trace('hata', { err: String(e.message || e) });
    if (cfg.device === 'webgpu' && !force && !Q.get('device')) {          // WebGPU failed -> WASM fallback
      post({ type: 'status', text: 'WebGPU çalışmadı (' + (e.message || e) + '), WASM deneniyor…' });
      cfg = await pickConfig('wasm'); T = { device: cfg.device, dtype: cfg.enc + '/' + cfg.dec };
      for (const f of cfg.files) if (!(await legacyHas(f))) await downloadFile(f, { add() {}, of: () => 0 });
      setThreads(cfg);
      asr = await build(cfg);
    } else throw e;
  }
  info = { device: cfg.device, label: cfg.label, mb: cfg.mb, threads: env.backends.onnx.wasm.numThreads, build: BUILD };
  trace('hazır', info);
  post({ type: 'ready', ...info });
}

let chain = Promise.resolve(), firstRun = true, previewCutoff = 0;
async function transcribe(m) {
  if (!m.final && m.id <= previewCutoff) { post({ type: 'result', id: m.id, text: '', skipped: true }); return; }   // recording already stopped
  const t0 = performance.now();
  if (firstRun) trace('ilk-çevirme-başladı');
  const opts = { task: 'transcribe', return_timestamps: false };
  if (m.language && m.language !== 'auto') opts.language = m.language;
  // final pass: the whole recording in one go. Longer than 30 s -> Whisper's own long-form windows (30 s, 5 s stride).
  const out = m.final ? await asr(m.audio, { ...opts, chunk_length_s: 30, stride_length_s: 5, max_new_tokens: 300 })
                      : await asr(m.audio, { ...opts, max_new_tokens: 220 });
  if (firstRun) { firstRun = false; trace('ilk-çevirme-bitti', { ms: Math.round(performance.now() - t0) }); }
  post({ type: 'result', id: m.id, final: !!m.final, text: (out.text || '').trim(), ms: Math.round(performance.now() - t0), dur: m.audio.length / 16000 });
}

self.onmessage = (e) => {
  const m = e.data;
  const fail = (err, id) => { const t = String((err && err.message) || err); trace('hata', { err: t }); post({ type: 'error', text: t, id }); };
  if (m.model) setModel(m.model);
  if (m.type === 'load') load(m.force).catch((err) => fail(err));
  else if (m.type === 'cancel-preview') previewCutoff = Math.max(previewCutoff, m.upto);
  else if (m.type === 'transcribe') chain = chain.then(() => transcribe(m)).catch((err) => fail(err, m.id));
  else if (m.type === 'probe') (async () => {       // is the model already fully stored? (for auto-load)
    try {
      const cfg = await pickConfig(m.force); let ok = true, have = 0, all = 0;
      for (const f of cfg.files) {
        const n = nChunks(SIZES[f]); all += n;
        if (await legacyHas(f)) { have += n; continue; }
        const h = (await haveChunks(f, SIZES[f])).length; have += h; if (h !== n) ok = false;
      }
      post({ type: 'cached', ok, have, all, label: cfg.label, mb: cfg.mb });
    } catch (err) { post({ type: 'cached', ok: false, have: 0, all: 0 }); }
  })();
  else if (m.type === 'wipe') (async () => {       // m.all: every model; otherwise only the selected one
    if (m.all) { for (const k of [CHUNK_CACHE, SMALL_CACHE, LEGACY_CACHE]) await caches.delete(k); }
    else for (const k of [CHUNK_CACHE, SMALL_CACHE, LEGACY_CACHE]) {
      if (!(await caches.has(k))) continue;
      const c = await caches.open(k);
      for (const r of await c.keys()) if (r.url.startsWith(BASE)) await c.delete(r);
    }
    post({ type: 'wiped', all: !!m.all });
  })();
};
