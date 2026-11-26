// Upload queue that survives closed tabs and dropped networks, with adaptive quality.
// Metadata lives in memory (fast) and in IndexedDB (survives reloads); photo files are stored once and never re-read
// on every progress tick. Large batches start uploading immediately while the rest are still being saved.
import { net, TIERS } from './core.js';
import { prepare } from './imaging.js';

const DB_NAME = 'wa-uploads';
let dbp = null;
function db() {
  dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 2);
    r.onupgradeneeded = (e) => {
      const d = r.result;
      if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
      if (e.oldVersion === 1) {
        // v1 kept the file inside each item: move files to their own store
        const t = r.transaction;
        const items = t.objectStore('items'), files = t.objectStore('files');
        items.openCursor().onsuccess = (ev) => {
          const c = ev.target.result; if (!c) return;
          const { file, ...meta } = c.value;
          if (file) files.put(file, meta.id);
          c.update({ ...meta, stored: !!file });
          c.continue();
        };
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('blocked'));
  });
  return dbp;
}
function tx(stores, mode, fn) {
  return db().then((d) => new Promise((res, rej) => {
    const t = d.transaction(stores, mode);
    let out;
    try { out = fn(t); } catch (e) { rej(e); return; }
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('aborted')); // e.g. storage full: never hang
  }));
}

const mem = new Map();   // id -> item metadata
const files = new Map(); // id -> File kept in this tab (always used first)
const live = new Map();  // id -> { progress }
const claimed = new Set();
const listeners = new Set();
let running = 0, wakeLock = null, retryTimer = null, loaded = null;
let batch = { start: 0, total: 0 }; // progress for the current run of uploads

function load() {
  loaded ||= tx(['items'], 'readonly', (t) => {
    const req = t.objectStore('items').openCursor();
    req.onsuccess = () => {
      const c = req.result; if (!c) return;
      mem.set(c.value.id, c.value);
      c.continue();
    };
  }).catch(() => {}).then(() => {
    // Items from a tab that closed before its photos were saved can't be sent any more
    for (const it of mem.values()) {
      if (it.status === 'uploading') it.status = 'queued';
      if (it.status !== 'done' && !it.stored && !files.has(it.id)) { it.status = 'error'; it.error = 'lost'; }
    }
  });
  return loaded;
}

function saveMeta(it) { mem.set(it.id, it); return tx(['items'], 'readwrite', (t) => t.objectStore('items').put(it)).catch(() => {}); }
async function getFile(id) {
  if (files.has(id)) return files.get(id);
  try { return await tx(['files'], 'readonly', (t) => t.objectStore('files').get(id)); } catch { return null; }
}
function dropFile(id) { files.delete(id); return tx(['files'], 'readwrite', (t) => t.objectStore('files').delete(id)).catch(() => {}); }
function dropItem(id) { mem.delete(id); files.delete(id); return tx(['items', 'files'], 'readwrite', (t) => { t.objectStore('items').delete(id); t.objectStore('files').delete(id); }).catch(() => {}); }

export const prefs = {
  get wifiOnly() { try { return localStorage.getItem('wa_wifi') === '1'; } catch { return false; } },
  set wifiOnly(v) { try { localStorage.setItem('wa_wifi', v ? '1' : '0'); } catch { /* */ } kick(); },
  get betterLater() { try { return localStorage.getItem('wa_better') !== '0'; } catch { return true; } },
  set betterLater(v) { try { localStorage.setItem('wa_better', v ? '1' : '0'); } catch { /* */ } },
};

// ---- change notifications, at most ~4 a second ----
let emitTimer = null;
export function onChange(f) { listeners.add(f); return () => listeners.delete(f); }
function emit() {
  if (emitTimer) return;
  emitTimer = setTimeout(() => { emitTimer = null; const list = [...mem.values()]; listeners.forEach((f) => f(list, live, summary())); }, 250);
}
export function summary() {
  let queued = 0, uploading = 0, failed = 0, error = 0, done = 0;
  for (const it of mem.values()) {
    if (it.status === 'queued') queued++; else if (it.status === 'uploading') uploading++;
    else if (it.status === 'failed') failed++; else if (it.status === 'error') error++; else if (it.status === 'done') done++;
  }
  const lost = [...mem.values()].filter((i) => i.error === 'lost').length;
  const capped = [...mem.values()].some((i) => i.status === 'error' && i.code === 'daily_cap');
  const pending = queued + uploading + failed;
  if (!pending && !batch.total) batch = { start: done, total: 0 };
  return { queued, uploading, failed, error, done, lost, capped, pending, unsaved: [...mem.values()].some((i) => i.status !== 'done' && !i.stored),
    batchTotal: batch.total || pending, batchSent: Math.max(0, done - batch.start) };
}

export async function add(list, meta) {
  await load();
  const fresh = [];
  for (const file of list) {
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|heic|heif|webp)$/i.test(file.name)) continue;
    const it = { id: crypto.randomUUID(), name: file.name, meta, status: 'queued', attempts: 0, addedAt: Date.now() + fresh.length, stored: false };
    mem.set(it.id, it); files.set(it.id, file); fresh.push(it);
  }
  const before = summary();
  if (!before.pending) batch = { start: before.done, total: 0 };
  batch.total += fresh.length;
  emit(); kick(); // start sending straight away
  // Save to the phone in the background so the queue survives a closed tab; if storage is full, keep going from memory
  for (const it of fresh) {
    if (!mem.has(it.id)) continue;
    try {
      await tx(['items', 'files'], 'readwrite', (t) => { t.objectStore('files').put(files.get(it.id), it.id); t.objectStore('items').put({ ...mem.get(it.id), stored: true }); });
      const cur = mem.get(it.id); if (cur) cur.stored = true;
    } catch {
      await saveMeta({ ...mem.get(it.id), stored: false });
      break; // storage is full: the rest stay in memory (keep the page open)
    }
  }
  emit();
}

export async function clearDone() {
  await load();
  for (const it of [...mem.values()]) if (it.status === 'done' && !it.needsUpgrade) await dropItem(it.id);
  emit();
}
export async function clearErrors() {
  await load();
  batch = { start: 0, total: 0 };
  for (const it of [...mem.values()]) if (it.status === 'error' || it.status === 'failed') await dropItem(it.id);
  emit();
}
export async function retryNow() {
  await load();
  for (const it of mem.values()) if (it.status === 'failed' || (it.status === 'error' && it.code !== 'daily_cap' && it.error !== 'lost')) { it.status = 'queued'; it.failedAt = 0; saveMeta(it); }
  emit(); kick();
}

async function storageLow() {
  try { const e = await navigator.storage.estimate(); return e.quota && e.quota - e.usage < 300 * 1024 * 1024; } catch { return false; }
}

function xhrUpload(url, blob, method, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    x.setRequestHeader('content-type', 'image/jpeg');
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      let data = null; try { data = JSON.parse(x.responseText); } catch { /* */ }
      if (x.status >= 200 && x.status < 300) resolve(data); else reject(Object.assign(new Error(data?.error || 'upload failed'), { status: x.status, data }));
    };
    x.onerror = () => reject(Object.assign(new Error('network'), { status: 0 }));
    x.ontimeout = () => reject(Object.assign(new Error('timeout'), { status: 0 }));
    x.timeout = 120_000;
    x.send(blob);
  });
}

function eventFor(config, ts) {
  if (!ts) return null;
  for (const e of config.events) if (e.from && e.to && ts >= Date.parse(e.from) && ts < Date.parse(e.to)) return e;
  return null;
}

let config = null;
export function setConfig(c) { config = c; }

const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(msg), { status: 0, local: true })), ms))]);

async function processItem(it) {
  const tierName = net.tier();
  const tier = TIERS[tierName];
  live.set(it.id, { progress: 0 }); emit();
  const file = await getFile(it.id);
  if (!file) throw Object.assign(new Error('lost'), { status: 410 });
  // A photo the phone cannot decode should fail, not freeze the queue
  let prep;
  try { prep = await withTimeout(prepare(file, tier), 45_000, 'timeout'); }
  catch { throw Object.assign(new Error('This photo could not be read. It may be damaged or in an unusual format.'), { status: 422 }); }
  let event = it.meta.event, side = it.meta.side;
  if (!event || event === 'auto') {
    const ev = eventFor(config, prep.takenAt);
    event = ev ? ev.id : 'other';
  }
  const ev = config.events.find((e) => e.id === event) || config.events[config.events.length - 1];
  if (!ev.sides.includes(side)) side = ev.sides.includes(it.meta.mySide) ? it.meta.mySide : ev.sides[0];
  const params = new URLSearchParams({ event, side });
  if (prep.takenAt) params.set('takenAt', String(prep.takenAt));
  if (it.meta.source) { params.set('source', it.meta.source); if (it.meta.credit) params.set('credit', it.meta.credit); }
  const t0 = performance.now();
  const res = await xhrUpload('/api/photos?' + params, prep.blob, 'POST', (p) => { live.set(it.id, { progress: p }); emit(); });
  net.record(prep.blob.size, performance.now() - t0);
  const lowTier = tierName === 'slow' || tierName === 'poor';
  const keep = lowTier && prefs.betterLater && it.stored && !(await storageLow());
  await saveMeta({ ...it, status: 'done', photoId: res.id, tierUsed: tierName, needsUpgrade: keep, doneAt: Date.now(), error: null });
  if (!keep) await dropFile(it.id);
}

async function upgradeItem(it) {
  const file = await getFile(it.id);
  if (!file) { await saveMeta({ ...it, needsUpgrade: false }); return; }
  const prep = await withTimeout(prepare(file, TIERS.fast), 45_000, 'decode');
  const t0 = performance.now();
  await xhrUpload(`/api/photos/${it.photoId}/upgrade`, prep.blob, 'PUT', () => {});
  net.record(prep.blob.size, performance.now() - t0);
  await saveMeta({ ...it, needsUpgrade: false });
  await dropFile(it.id);
}

const backoff = (attempts) => Math.min(60_000, 3000 * 2 ** Math.min(attempts, 5));

function next() {
  let best = null;
  const t = Date.now();
  for (const i of mem.values()) {
    if (claimed.has(i.id)) continue;
    const ready = i.status === 'queued' || (i.status === 'failed' && t - (i.failedAt || 0) > backoff(i.attempts));
    if (ready && (!best || i.addedAt < best.addedAt)) best = i;
  }
  if (best) { claimed.add(best.id); return { kind: 'upload', item: best }; }
  if (net.tier() === 'fast' || net.onWifi()) {
    for (const i of mem.values()) if (i.needsUpgrade && !claimed.has(i.id)) { claimed.add(i.id); return { kind: 'upgrade', item: i }; }
  }
  return null;
}

let stopReason = null; // shown in the UI when the whole queue is paused for a reason
async function worker() {
  running++;
  try {
    for (;;) {
      if (!net.online()) { stopReason = 'offline'; break; }
      if (prefs.wifiOnly && net.onWifi() === false) { stopReason = 'wifi_only'; break; }
      stopReason = null;
      const job = next();
      if (!job) break;
      const it = job.item;
      if (job.kind === 'upload') { it.status = 'uploading'; emit(); }
      try {
        if (job.kind === 'upload') await processItem(it); else await upgradeItem(it);
      } catch (e) {
        if (job.kind === 'upgrade') { await saveMeta({ ...it, needsUpgrade: false }); continue; }
        const daily = e.status === 429 && /limit/i.test(e.message || '');
        // Give up on a photo after 8 tries (it can still be retried by hand); damaged files fail at once
        const permanent = daily || e.status === 410 || it.attempts + 1 >= 8 || (e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 408);
        await saveMeta({ ...it, status: permanent ? 'error' : 'failed', code: daily ? 'daily_cap' : e.data?.code, error: e.data?.error || e.message, attempts: it.attempts + 1, failedAt: Date.now() });
        if (daily || (e.status === 403 && e.data?.code === 'enroll_first')) { stopReason = daily ? 'daily_cap' : 'enroll'; if (daily) markRest('daily_cap', e.message); break; }
        if (e.status === 401) { stopReason = 'signed_out'; break; }
      } finally {
        live.delete(it.id); claimed.delete(it.id); emit();
      }
    }
  } finally {
    running--;
    if (!running) { releaseWake(); scheduleRetry(); }
  }
}

function markRest(code, msg) {
  for (const it of mem.values()) if (it.status === 'queued' || it.status === 'failed') { it.status = 'error'; it.code = code; it.error = msg; saveMeta(it); }
}

// When the queue goes idle with failures still waiting, wake up again when the next one is due
function scheduleRetry() {
  clearTimeout(retryTimer);
  let soonest = Infinity;
  for (const i of mem.values()) if (i.status === 'failed') soonest = Math.min(soonest, (i.failedAt || 0) + backoff(i.attempts));
  if (soonest < Infinity) retryTimer = setTimeout(kick, Math.max(1000, soonest - Date.now() + 200));
}

async function holdWake() {
  try { if (!wakeLock && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* */ }
}
function releaseWake() { try { wakeLock?.release(); } catch { /* */ } wakeLock = null; }

export async function kick() {
  await load();
  const want = TIERS[net.tier()].conc;
  if (running < want) {
    holdWake();
    for (let i = running; i < want; i++) worker();
  }
  emit();
}

export async function pendingCount() { await load(); return summary().pending; }
export function status() { return { reason: stopReason, running, ...summary() }; }
export async function items() { await load(); return [...mem.values()]; }

window.addEventListener('online', () => kick());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(); });
window.addEventListener('beforeunload', (e) => { if (running || summary().unsaved) { e.preventDefault(); e.returnValue = ''; } });
