const $ = (id) => document.getElementById(id);
const out = $('out'), mic = $('mic'), loadBtn = $('loadBtn'), fileIn = $('file');
const SR = 16000;
let ready = false, recording = false, finalizing = false, previewText = '', pending = 0, nextId = 1;
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
    ready = true; sel.disabled = false; $('progWrap').hidden = true; loadBtn.hidden = true;
    $('modelInfo').textContent = MODEL_UI[chosen].name + ' hazır (' + m.label + '). Artık çevrimdışı çalışır.';
    $('status').textContent = '';
    mic.disabled = false; fileIn.disabled = false; $('micHint').textContent = 'Konuşmak için dokun';
    window.__ready = m;
  } else if (m.type === 'result') {
    pending--;
    if (m.final) { $('preview').textContent = ''; previewText = ''; appendText(m.text); $('status').textContent = pending ? 'Yazılıyor…' : ''; mic.disabled = false; }
    else if (!m.skipped && recording) { previewText += (previewText ? ' ' : '') + m.text; $('preview').textContent = previewText; }
    else if (!recording && !m.skipped && !finalizing) { /* late preview after stop: ignore */ }
    if (!m.final) $('status').textContent = recording ? 'Dinliyorum…' : $('status').textContent;
    (waiters.get(m.id) || (() => {}))(m); window.__last = m;
  } else if (m.type === 'error') {
    pending = Math.max(0, pending - 1); mic.disabled = !ready;
    $('status').textContent = 'Hata: ' + m.text; loadBtn.disabled = false; sel.disabled = false;
    if (waiters.has(m.id)) waiters.get(m.id)({ error: m.text });
    window.__err = m.text;
  }
};
function appendText(t) {
  if (!t) return;
  out.value += (out.value && !/\s$/.test(out.value) ? ' ' : '') + t;
  out.scrollTop = out.scrollHeight;
}
function send(audio, final) {
  const id = nextId++; pending++;
  if (final) $('status').textContent = 'Tüm kayıt çevriliyor… (uzun kayıtlar biraz sürebilir)';
  worker.postMessage({ type: 'transcribe', id, audio, final: !!final, language: $('lang').value }, [audio.buffer]);
  return new Promise((res) => waiters.set(id, res));
}

// ---- Model picker (remembered in localStorage) ----
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MODEL_UI = {
  small: { name: 'iPhone için (küçük)', size: '~223 MB', desc: 'Whisper small, telefonda çalışır. Turbo kadar doğru değil.' },
  turbo: { name: 'Turbo (büyük, bilgisayar için)', size: '564–759 MB', desc: 'Whisper large-v3-turbo, en iyi doğruluk. iPhone sekmesine sığmıyor.' },
};
const urlModel = new URLSearchParams(location.search).get('model');
let chosen = MODEL_UI[urlModel] ? urlModel : (MODEL_UI[localStorage.getItem('dikte.model')] ? localStorage.getItem('dikte.model') : (IS_IOS ? 'small' : 'turbo'));
const sel = $('model');
for (const k of ['small', 'turbo']) { const o = document.createElement('option'); o.value = k; o.textContent = MODEL_UI[k].name + ' · ' + MODEL_UI[k].size + (k === (IS_IOS ? 'small' : 'turbo') ? ' · önerilen' : ''); sel.appendChild(o); }
sel.value = chosen;
let loadStarted = false;
const showModel = () => { $('modelInfo').textContent = MODEL_UI[chosen].desc + ' Tamamen bu cihazda çalışır, ses hiçbir yere gönderilmez.'; loadBtn.textContent = 'Modeli indir ve yükle (' + MODEL_UI[chosen].size + ')'; };
showModel();
sel.onchange = () => {
  chosen = sel.value; localStorage.setItem('dikte.model', chosen);
  if (loadStarted || ready) { location.href = location.pathname + location.search.replace(/[?&]model=[^&]*/, '').replace(/^&/, '?'); return; }
  showModel(); worker.postMessage({ type: 'probe', model: chosen, force: new URLSearchParams(location.search).get('device') });
};

loadBtn.onclick = () => {
  loadStarted = true; sel.disabled = true; loadBtn.disabled = true; $('status').textContent = 'Model indiriliyor…'; $('progWrap').hidden = false;
  worker.postMessage({ type: 'load', model: chosen, force: new URLSearchParams(location.search).get('device') });
};
// ---- Crash-resilient diagnostics: the last stage is written to localStorage on every change ----
const BUILD = '2026-10-28-m9';
const TRACE_KEY = 'dikte.trace';
let lastTrace = null, lastWrite = 0;
const readTrace = () => { try { return JSON.parse(localStorage.getItem(TRACE_KEY) || 'null'); } catch (e) { return null; } };
function writeTrace(t, force) {
  const now = Date.now(); lastTrace = { ...t, t: now };
  if (!force && now - lastWrite < 700) return;
  lastWrite = now;
  try { localStorage.setItem(TRACE_KEY, JSON.stringify(lastTrace)); } catch (e) {}
}
const prev = readTrace();
const crashed = !!(prev && prev.state === 'running');
if (crashed) {
  const where = [prev.stage, prev.file, prev.device && (prev.device + ' ' + prev.dtype), prev.loaded != null ? Math.round(prev.loaded / 1048576) + ' MB' : '', prev.err].filter(Boolean).join(' · ');
  $('last').textContent = 'Son deneme şu aşamada kesildi: ' + where + ' (' + new Date(prev.t).toLocaleTimeString('tr-TR') + '). Bu bilgi sorunu bulmak için kaydedildi.';
  $('last').hidden = false;
} else if (prev && prev.state === 'error') {
  $('last').textContent = 'Son deneme hata verdi: ' + (prev.err || prev.stage); $('last').hidden = false;
}
writeTrace({ state: 'idle', stage: 'sayfa açıldı' }, true);
addEventListener('pagehide', (e) => { if (!e.persisted && lastTrace && lastTrace.state === 'running') writeTrace({ ...lastTrace, state: 'closed' }, true); });
addEventListener('error', (e) => { $('status').textContent = 'Hata: ' + (e.message || e); writeTrace({ ...(lastTrace || {}), state: 'error', stage: 'sayfa-hatası', err: String(e.message || e) }, true); });
addEventListener('unhandledrejection', (e) => { const t = String((e.reason && e.reason.message) || e.reason); $('status').textContent = 'Hata: ' + t; writeTrace({ ...(lastTrace || {}), state: 'error', stage: 'sayfa-reddi', err: t }, true); });
let lastLoaded = 0;
worker.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'trace') {
    const { type, ...rest } = m;
    const st = (rest.stage === 'hazır' || rest.stage === 'ilk-çevirme-bitti') ? 'ready' : /hata|error|rejection/.test(rest.stage) ? 'error' : 'running';
    writeTrace({ ...rest, state: st, loaded: lastLoaded }, true);
  } else if (m.type === 'progress') { lastLoaded = m.loaded; if (lastTrace && lastTrace.state === 'running') writeTrace({ ...lastTrace, stage: lastTrace.stage, loaded: m.loaded, file: (m.file || '').replace('onnx/', '') }, false); }
  else if (m.type === 'error' && lastTrace && lastTrace.state !== 'error') writeTrace({ ...lastTrace, state: 'error', err: m.text }, true);
  else if (m.type === 'wiped') { $('status').textContent = 'İndirilen model silindi. Sayfa yenileniyor…'; setTimeout(() => location.reload(), 800); }
  else if (m.type === 'cached') {
    if (m.ok && !crashed) loadBtn.click();                            // already stored and last run did not die: load by itself (works offline)
    else if (!m.have) showModel();
    else if (m.have > 0 && !m.ok) loadBtn.textContent = 'İndirmeye devam et (' + Math.round(100 * m.have / m.all) + '% hazır)';
    else if (m.ok && crashed) loadBtn.textContent = 'Modeli belleğe yükle (indirilmiş)';
  }
});
worker.postMessage({ type: 'probe', model: chosen, force: new URLSearchParams(location.search).get('device') });
if (new URLSearchParams(location.search).get('auto')) loadBtn.click();
$('wipe').onclick = () => { if (confirm('Seçili model (' + MODEL_UI[chosen].name + ') silinsin mi?')) worker.postMessage({ type: 'wipe', model: chosen }); };
$('wipeAll').onclick = () => { if (confirm('İndirilen tüm modeller silinsin mi?')) worker.postMessage({ type: 'wipe', model: chosen, all: true }); };
$('envInfo').textContent += ' · sürüm ' + BUILD;

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
// Live preview only: short chunks, shown grey/italic, thrown away when the full-recording pass finishes.
function flush() {
  if (!bufLen) return;
  const a = takeBuffer();
  if (a.length < SR * 0.5 || rms(a) < 0.005) return;      // skip silence (avoids hallucinations)
  send(a, false);
}
function tick() {
  const secs = bufLen / rate;
  const last = buf[buf.length - 1];
  let paused = false;
  if (last) paused = rms(last.length > 2048 ? last.subarray(last.length - 2048) : last) < 0.008;
  quietRun = paused ? quietRun + 1 : 0;
  if ((secs >= 3.5 && quietRun >= 2) || secs >= 9) { quietRun = 0; flush(); }
}
let full = [], fullLen = 0;
async function startRec() {
  // raw microphone: browser echo-cancel / noise-suppress / auto-gain distort speech and hurt recognition
  stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.resume(); rate = ctx.sampleRate;
  await ctx.audioWorklet.addModule('audio-worklet.js');
  const src = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, 'cap');
  full = []; fullLen = 0; buf = []; bufLen = 0; previewText = ''; $('preview').textContent = '';
  node.port.onmessage = (e) => { full.push(e.data); fullLen += e.data.length; if ($('live').checked) { buf.push(e.data); bufLen += e.data.length; } };
  src.connect(node);
  const mute = ctx.createGain(); mute.gain.value = 0; node.connect(mute).connect(ctx.destination);
  timer = setInterval(tick, 250);
  recording = true; mic.classList.add('rec'); $('micHint').textContent = 'Dinliyorum… bitirince dokun, tüm kayıt tek seferde çevrilir';
}
async function stopRec() {
  recording = false; clearInterval(timer); mic.classList.remove('rec');
  worker.postMessage({ type: 'cancel-preview', upto: nextId - 1 });        // drop queued preview chunks
  try { node.disconnect(); } catch (e) {}
  stream.getTracks().forEach(t => t.stop());
  await ctx.close();
  const all = new Float32Array(fullLen); let o = 0;
  for (const b of full) { all.set(b, o); o += b.length; }
  full = []; fullLen = 0; buf = []; bufLen = 0;
  const a16 = resample(all, rate);
  $('micHint').textContent = 'Konuşmak için dokun';
  if (a16.length < SR * 0.4 || rms(a16) < 0.002) { $('preview').textContent = ''; previewText = ''; $('status').textContent = 'Ses algılanmadı.'; return; }
  finalizing = true; mic.disabled = true;
  $('preview').textContent = previewText ? previewText + ' …' : '';
  send(a16, true);                                                            // ONE pass over the whole recording (long-form: 30 s windows, 5 s stride)
}
mic.onclick = async () => {
  if (!ready) return;
  try { recording ? await stopRec() : await startRec(); }
  catch (e) { $('status').textContent = 'Mikrofon hatası: ' + (e.message || e); mic.disabled = false; }
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
  const a = await decodeFile(file);
  if (rms(a) < 0.001) { $('status').textContent = 'Ses algılanmadı.'; return; }
  await send(a, true);                       // whole file in one pass (long-form handled inside the worker)
}
fileIn.onchange = async () => { const f = fileIn.files[0]; if (f) { try { await transcribeFile(f); } catch (e) { $('status').textContent = 'Dosya hatası: ' + (e.message || e); } fileIn.value = ''; } };
window.__transcribeFile = transcribeFile;   // for automated tests

$('copy').onclick = async () => { try { await navigator.clipboard.writeText(out.value); $('copy').textContent = 'Kopyalandı'; } catch (e) { out.select(); document.execCommand('copy'); } setTimeout(() => $('copy').textContent = 'Kopyala', 1200); };
$('clear').onclick = () => { out.value = ''; };
