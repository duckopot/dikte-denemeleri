const $ = (id) => document.getElementById(id);
const out = $('out'), mic = $('mic'), loadBtn = $('loadBtn'), fileIn = $('file');
const SR = 16000;
let ready = false, recording = false, pending = 0, nextId = 1;
const waiters = new Map();

// ---- Service worker (offline shell + cross-origin isolation for WASM threads) ----
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(async (reg) => {
    await navigator.serviceWorker.ready;
    if (!crossOriginIsolated && !sessionStorage.getItem('iso-reload') && navigator.serviceWorker.controller) {
      sessionStorage.setItem('iso-reload', '1'); location.reload();
    } else if (!crossOriginIsolated && !navigator.serviceWorker.controller && !sessionStorage.getItem('iso-reload')) {
      sessionStorage.setItem('iso-reload', '1'); location.reload();
    }
  }).catch(() => {});
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
$('envInfo').textContent = (crossOriginIsolated ? 'çok iş parçacıklı' : 'tek iş parçacıklı') + ' · ' + (navigator.gpu ? 'WebGPU var' : 'WebGPU yok');

// ---- Worker ----
const worker = new Worker('worker.js' + location.search, { type: 'module' });
worker.onerror = (e) => { $('status').textContent = 'Worker hatası: ' + (e.message || 'yüklenemedi'); window.__err = 'worker: ' + e.message; };
worker.onmessageerror = () => {};
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') {
    $('progWrap').hidden = false;
    const pct = Math.min(100, m.loaded / m.total * 100);
    $('bar').style.width = pct.toFixed(1) + '%';
    $('progText').textContent = pct.toFixed(0) + '% · ' + (m.loaded / 1048576).toFixed(0) + ' / ' + (m.total / 1048576).toFixed(0) + ' MB';
  } else if (m.type === 'status') $('status').textContent = m.text;
  else if (m.type === 'ready') {
    ready = true; $('progWrap').hidden = true; loadBtn.hidden = true;
    $('modelInfo').textContent = 'Model hazır (' + m.label + '). Artık çevrimdışı çalışır.';
    $('status').textContent = '';
    mic.disabled = false; fileIn.disabled = false; $('micHint').textContent = 'Konuşmak için dokun';
    window.__ready = m;
  } else if (m.type === 'result') {
    pending--; appendText(m.text); $('status').textContent = pending ? 'Yazılıyor…' : '';
    (waiters.get(m.id) || (() => {}))(m); window.__last = m;
  } else if (m.type === 'error') {
    pending = Math.max(0, pending - 1);
    $('status').textContent = 'Hata: ' + m.text; loadBtn.disabled = false;
    if (waiters.has(m.id)) waiters.get(m.id)({ error: m.text });
    window.__err = m.text;
  }
};
function appendText(t) {
  if (!t) return;
  out.value += (out.value && !/\s$/.test(out.value) ? ' ' : '') + t;
  out.scrollTop = out.scrollHeight;
}
function send(audio) {
  const id = nextId++; pending++;
  $('status').textContent = 'Yazılıyor…';
  worker.postMessage({ type: 'transcribe', id, audio, language: $('lang').value }, [audio.buffer]);
  return new Promise((res) => waiters.set(id, res));
}

loadBtn.onclick = () => {
  loadBtn.disabled = true; $('status').textContent = 'Model indiriliyor…'; $('progWrap').hidden = false;
  worker.postMessage({ type: 'load', force: new URLSearchParams(location.search).get('device') });
};
// If the model is already cached, load automatically (works offline).
(async () => {
  try {
    if (await caches.has('transformers-cache')) {
      const c = await caches.open('transformers-cache');
      const keys = await c.keys();
      if (keys.some(r => r.url.includes('decoder_model_merged'))) loadBtn.click();
    }
  } catch (e) {}
})();
if (new URLSearchParams(location.search).get('auto')) loadBtn.click();

// ---- Live dictation ----
let ctx, stream, node, buf = [], bufLen = 0, timer, quietRun = 0, rate;
const rms = (a, from = 0) => { let s = 0; for (let i = from; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, a.length - from)); };
function resample(a, from) {
  if (from === SR) return a;
  const n = Math.floor(a.length * SR / from), o = new Float32Array(n), r = from / SR;
  for (let i = 0; i < n; i++) { const p = i * r, i0 = Math.floor(p), i1 = Math.min(a.length - 1, i0 + 1), f = p - i0; o[i] = a[i0] * (1 - f) + a[i1] * f; }
  return o;
}
function takeBuffer() {
  const all = new Float32Array(bufLen); let o = 0;
  for (const b of buf) { all.set(b, o); o += b.length; }
  buf = []; bufLen = 0; return resample(all, rate);
}
function flush(final) {
  if (!bufLen) return;
  const a = takeBuffer();
  if (a.length < SR * 0.5 || rms(a) < 0.005) return;      // skip silence (avoids hallucinations)
  send(a);
}
function tick() {
  const secs = bufLen / rate;
  const tailN = Math.floor(rate * 0.5), last = buf[buf.length - 1];
  // cut when we have >=3.5 s and the speaker just paused, or force-cut at 9 s
  let paused = false;
  if (last) paused = rms(last.length > 2048 ? last.subarray(last.length - 2048) : last) < 0.008;
  quietRun = paused ? quietRun + 1 : 0;
  if ((secs >= 3.5 && quietRun >= 2) || secs >= 9) { quietRun = 0; flush(); }
}
async function startRec() {
  stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.resume(); rate = ctx.sampleRate;
  await ctx.audioWorklet.addModule('audio-worklet.js');
  const src = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, 'cap');
  node.port.onmessage = (e) => { buf.push(e.data); bufLen += e.data.length; };
  src.connect(node);
  const mute = ctx.createGain(); mute.gain.value = 0; node.connect(mute).connect(ctx.destination);
  timer = setInterval(tick, 250);
  recording = true; mic.classList.add('rec'); $('micHint').textContent = 'Dinliyorum… durdurmak için dokun';
}
async function stopRec() {
  recording = false; clearInterval(timer); mic.classList.remove('rec');
  flush(true);
  try { node.disconnect(); } catch (e) {}
  stream.getTracks().forEach(t => t.stop());
  await ctx.close();
  $('micHint').textContent = 'Konuşmak için dokun';
}
mic.onclick = async () => {
  if (!ready) return;
  try { recording ? await stopRec() : await startRec(); }
  catch (e) { $('status').textContent = 'Mikrofon hatası: ' + (e.message || e); }
};

// ---- File upload ----
async function decodeFile(file) {
  const ab = await file.arrayBuffer();
  const tmp = new (window.AudioContext || window.webkitAudioContext)();
  const dec = await tmp.decodeAudioData(ab); tmp.close();
  const len = Math.ceil(dec.duration * SR);
  const oc = new OfflineAudioContext(1, len, SR);
  const s = oc.createBufferSource(); s.buffer = dec; s.connect(oc.destination); s.start();
  return (await oc.startRendering()).getChannelData(0);
}
async function transcribeFile(file) {
  $('status').textContent = 'Dosya çözülüyor…';
  const a = await decodeFile(file), step = SR * 28;
  for (let i = 0; i < a.length; i += step) {
    const part = a.slice(i, Math.min(a.length, i + step));
    if (rms(part) < 0.003) continue;
    $('status').textContent = 'Yazılıyor… %' + Math.round(i / a.length * 100);
    await send(part);
  }
  $('status').textContent = '';
}
fileIn.onchange = async () => { const f = fileIn.files[0]; if (f) { try { await transcribeFile(f); } catch (e) { $('status').textContent = 'Dosya hatası: ' + (e.message || e); } fileIn.value = ''; } };
window.__transcribeFile = transcribeFile;   // for automated tests

$('copy').onclick = async () => { try { await navigator.clipboard.writeText(out.value); $('copy').textContent = 'Kopyalandı'; } catch (e) { out.select(); document.execCommand('copy'); } setTimeout(() => $('copy').textContent = 'Kopyala', 1200); };
$('clear').onclick = () => { out.value = ''; };
