import { pipeline, env } from './vendor/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;                 // Cache API ("transformers-cache")
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', self.location.href).href;  // no CDN
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

const MODEL = 'onnx-community/whisper-large-v3-turbo';
let asr = null, info = null;
self.__dbg = new URL(self.location.href).searchParams.get('dbg');
const post = (m) => self.postMessage(m);

async function pickConfig(force) {
  let hasGPU = false, f16 = false;
  try {
    if (navigator.gpu && force !== 'wasm') {
      const a = await navigator.gpu.requestAdapter();
      if (a) { hasGPU = true; f16 = a.features.has('shader-f16'); }
    }
  } catch (e) {}
  if (hasGPU && f16) return { device: 'webgpu', dtype: { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' }, mb: 564, label: 'WebGPU · q4f16' };
  if (hasGPU)        return { device: 'webgpu', dtype: { encoder_model: 'q4',    decoder_model_merged: 'q4' },    mb: 759, label: 'WebGPU · q4' };
  return                    { device: 'wasm',   dtype: { encoder_model: 'q4',    decoder_model_merged: 'q4' },    mb: 759, label: 'WASM · q4' };
}

async function load(force) {
  if (asr) { post({ type: 'ready', ...info }); return; }
  let cfg = await pickConfig(force);
  const files = {};
  const cb = (p) => {
    if (self.__dbg) post({ type: 'status', text: JSON.stringify(p).slice(0,150) });
    if (p.status === 'progress' && p.total) {
      files[p.file] = { l: p.loaded, t: p.total };
      let l = 0, t = 0; for (const k in files) { l += files[k].l; t += files[k].t; }
      post({ type: 'progress', loaded: l, total: Math.max(t, cfg.mb * 1048576 * 0.98), file: p.file });
    } else if (p.status === 'initiate') post({ type: 'status', text: 'Hazırlanıyor: ' + p.file });
  };
  const build = (c) => pipeline('automatic-speech-recognition', MODEL, { device: c.device, dtype: c.dtype, progress_callback: cb });
  try {
    asr = await build(cfg);
  } catch (e) {
    if (cfg.device === 'webgpu') {            // WebGPU failed -> WASM fallback
      post({ type: 'status', text: 'WebGPU çalışmadı (' + (e.message || e) + '), WASM deneniyor…' });
      cfg = await pickConfig('wasm');
      asr = await build(cfg);
    } else throw e;
  }
  info = { device: cfg.device, label: cfg.label, mb: cfg.mb, threads: env.backends.onnx.wasm.numThreads };
  post({ type: 'ready', ...info });
}

let chain = Promise.resolve();
async function transcribe(m) {
  const t0 = performance.now();
  const out = await asr(m.audio, { language: m.language, task: 'transcribe', return_timestamps: false, max_new_tokens: 220 });
  post({ type: 'result', id: m.id, text: (out.text || '').trim(), ms: Math.round(performance.now() - t0), dur: m.audio.length / 16000 });
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') load(m.force).catch(err => post({ type: 'error', text: String(err && err.message || err) }));
  else if (m.type === 'transcribe') chain = chain.then(() => transcribe(m)).catch(err => post({ type: 'error', text: String(err && err.message || err), id: m.id }));
  else if (m.type === 'clear-queue') { /* queue is sequential; nothing pending to drop */ }
};
