// Upload queue that survives closed tabs and dropped networks (IndexedDB), with adaptive quality.
import { net, TIERS } from './core.js';
import { prepare } from './imaging.js';

const DB_NAME = 'wa-uploads';
let dbp = null;
function db() {
  dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('items', mode);
    const out = fn(t.objectStore('items'));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  });
}
const put = (item) => tx('readwrite', (s) => s.put(item));
const del = (id) => tx('readwrite', (s) => s.delete(id));
const all = () => tx('readonly', (s) => s.getAll());

const listeners = new Set();
const live = new Map(); // id -> { progress }
const claimed = new Set(); // items a worker in this tab is handling (prevents double uploads)
let running = 0;
let wakeLock = null;

export const prefs = {
  get wifiOnly() { try { return localStorage.getItem('wa_wifi') === '1'; } catch { return false; } },
  set wifiOnly(v) { try { localStorage.setItem('wa_wifi', v ? '1' : '0'); } catch { /* */ } kick(); },
  get betterLater() { try { return localStorage.getItem('wa_better') !== '0'; } catch { return true; } },
  set betterLater(v) { try { localStorage.setItem('wa_better', v ? '1' : '0'); } catch { /* */ } },
};

export function onChange(f) { listeners.add(f); return () => listeners.delete(f); }
async function emit() { const items = await all(); listeners.forEach((f) => f(items, live)); }

export async function add(files, meta) {
  for (const file of files) {
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|heic|webp)$/i.test(file.name)) continue;
    await put({ id: crypto.randomUUID(), file, name: file.name, meta, status: 'queued', attempts: 0, addedAt: Date.now() });
  }
  emit(); kick();
}

export async function clearDone() {
  for (const it of await all()) if (it.status === 'done' && !it.needsUpgrade) await del(it.id);
  emit();
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

async function processItem(it) {
  const tierName = net.tier();
  const tier = TIERS[tierName];
  live.set(it.id, { progress: 0 }); emit();
  const prep = await prepare(it.file, tier);
  // Event: the guest's choice, else by capture time, else "other"
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
  const keep = lowTier && prefs.betterLater && !(await storageLow());
  await put({ ...it, status: 'done', photoId: res.id, tierUsed: tierName, needsUpgrade: keep, file: keep ? it.file : null });
}

async function upgradeItem(it) {
  const prep = await prepare(it.file, TIERS.fast);
  const t0 = performance.now();
  await xhrUpload(`/api/photos/${it.photoId}/upgrade`, prep.blob, 'PUT', () => {});
  net.record(prep.blob.size, performance.now() - t0);
  await del(it.id);
}

async function next() {
  const items = (await all()).filter((i) => !claimed.has(i.id));
  // Everything below is synchronous, so two workers can never claim the same item
  const queued = items.filter((i) => i.status === 'queued' || (i.status === 'failed' && Date.now() - (i.failedAt || 0) > Math.min(300_000, 5000 * 2 ** i.attempts)));
  if (queued.length) {
    const item = queued.sort((a, b) => a.addedAt - b.addedAt)[0];
    claimed.add(item.id);
    return { kind: 'upload', item };
  }
  if (net.tier() === 'fast' || net.onWifi()) {
    const up = items.find((i) => i.needsUpgrade);
    if (up) { claimed.add(up.id); return { kind: 'upgrade', item: up }; }
  }
  return null;
}

async function worker() {
  running++;
  try {
    for (;;) {
      if (!net.online()) break;
      if (prefs.wifiOnly && net.onWifi() === false) break;
      const job = await next();
      if (!job) break;
      const it = job.item;
      await put({ ...it, status: job.kind === 'upload' ? 'uploading' : it.status });
      try {
        if (job.kind === 'upload') await processItem(it); else await upgradeItem(it);
      } catch (e) {
        if (job.kind === 'upgrade') { await put({ ...it, needsUpgrade: false, file: null }); continue; }
        const permanent = e.status && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 408;
        await put({ ...it, status: permanent ? 'error' : 'failed', error: e.data?.error || e.message, attempts: it.attempts + 1, failedAt: Date.now() });
        if (e.status === 403 && e.data?.code === 'enroll_first') break;
        if (!permanent) await new Promise((r) => setTimeout(r, 1500));
      } finally {
        live.delete(it.id); claimed.delete(it.id); emit();
      }
    }
  } finally {
    running--;
    if (!running) releaseWake();
  }
}

async function holdWake() {
  try { if (!wakeLock && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* */ }
}
function releaseWake() { try { wakeLock?.release(); } catch { /* */ } wakeLock = null; }

export async function kick() {
  // Recover items left "uploading" by a closed tab
  for (const it of await all()) if (it.status === 'uploading' && !claimed.has(it.id)) await put({ ...it, status: 'queued' });
  const want = TIERS[net.tier()].conc;
  if (running < want) { holdWake(); for (let i = running; i < want; i++) worker(); }
}

export async function pendingCount() {
  return (await all()).filter((i) => i.status === 'queued' || i.status === 'uploading' || i.status === 'failed').length;
}

window.addEventListener('online', () => kick());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(); });
window.addEventListener('beforeunload', (e) => { if (running) { e.preventDefault(); e.returnValue = ''; } });

export { all as items };
