// API client, network-quality estimate, device capability, small DOM helpers, sounds.

export class ApiError extends Error {
  constructor(status, data) { super(data?.error || `Request failed (${status})`); this.status = status; this.data = data || {}; }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const init = { method, credentials: 'same-origin', signal, headers: {} };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  let res;
  try { res = await fetch(path, init); } catch (e) { throw new ApiError(0, { error: 'offline' }); }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const thumbUrl = (id) => `/img/thumb/${id}.jpg`;
export const viewUrl = (id) => `/img/${net.tier() === 'fast' ? 'full' : 'view'}/${id}.jpg`;
export const dlUrl = (id) => `/img/full/${id}.jpg?dl=1`;
export const cropUrl = (faceId) => `/img/crop/${faceId}.jpg`;

// ---------------- device ----------------
export const device = (() => {
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  const saveData = !!navigator.connection?.saveData;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lite = mem <= 2 || cores <= 4 && mem <= 3 || saveData || reduced;
  return { mem, cores, saveData, lite, ios: /iP(hone|ad|od)/.test(navigator.userAgent) };
})();

// ---------------- network quality (adaptive upload/view) ----------------
// Tiers: fast >3 Mbps, good 1-3, slow 0.3-1, poor <0.3
export const TIERS = {
  fast: { edge: 2560, q: 0.88, conc: 3 },
  good: { edge: 2048, q: 0.85, conc: 2 },
  slow: { edge: 1600, q: 0.8, conc: 1 },
  poor: { edge: 1280, q: 0.75, conc: 1 },
};
const ORDER = ['poor', 'slow', 'good', 'fast'];

export const net = (() => {
  let mbps = null;
  let current = null;
  let upStreak = 0;
  const listeners = new Set();

  function fromHints() {
    const c = navigator.connection;
    if (!c) return 'good';
    if (c.saveData) return 'slow';
    const et = c.effectiveType;
    if (et === 'slow-2g' || et === '2g') return 'poor';
    if (et === '3g') return 'slow';
    if (typeof c.downlink === 'number' && c.downlink >= 5) return 'fast';
    return 'good';
  }
  const tierOf = (m) => (m > 3 ? 'fast' : m > 1 ? 'good' : m > 0.3 ? 'slow' : 'poor');

  return {
    tier() { return current || fromHints(); },
    settings() { return TIERS[this.tier()]; },
    online: () => navigator.onLine !== false,
    onWifi() { const c = navigator.connection; return c && c.type ? c.type === 'wifi' || c.type === 'ethernet' : null; },
    /** Record an upload: bytes sent, milliseconds taken. Step down fast, step up slowly. */
    record(bytes, ms) {
      if (ms < 50 || bytes < 20_000) return;
      const sample = (bytes * 8) / (ms / 1000) / 1e6;
      mbps = mbps == null ? sample : mbps * 0.6 + sample * 0.4;
      const target = tierOf(mbps);
      const cur = this.tier();
      if (ORDER.indexOf(target) < ORDER.indexOf(cur)) { current = target; upStreak = 0; }
      else if (ORDER.indexOf(target) > ORDER.indexOf(cur)) {
        if (++upStreak >= 3) { current = ORDER[ORDER.indexOf(cur) + 1]; upStreak = 0; }
      } else upStreak = 0;
      if (current !== cur) listeners.forEach((f) => f(current));
    },
    mbps: () => mbps,
    on(f) { listeners.add(f); },
  };
})();

// ---------------- DOM ----------------
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // only ever used with static strings
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** replaceChildren that skips null/false children (conditional UI) */
export function fill(el, ...kids) { el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false)); return el; }

export function toast(msg, ms = 3200) {
  const el = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, ms);
}

export function sheet(content, { onClose } = {}) {
  const wrap = h('div', { class: 'sheet-wrap' });
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'grab' }), content);
  const close = () => { wrap.classList.remove('open'); setTimeout(() => wrap.remove(), 300); onClose?.(); };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.append(panel);
  document.body.append(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  return { close, panel };
}

export function petals(n = 18) {
  if (device.lite) return;
  const box = h('div', { class: 'petals', 'aria-hidden': 'true' });
  for (let i = 0; i < n; i++) {
    const p = h('i');
    p.style.left = Math.random() * 100 + '%';
    p.style.animationDelay = Math.random() * 1.2 + 's';
    p.style.animationDuration = 2.6 + Math.random() * 2 + 's';
    p.style.transform = `scale(${0.6 + Math.random() * 0.8})`;
    box.append(p);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 5200);
}

// ---------------- sounds (optional files in /audio) ----------------
const sounds = {};
export const sound = {
  enabled() { try { return localStorage.getItem('wa_sound') === '1'; } catch { return false; } },
  set(on) { try { localStorage.setItem('wa_sound', on ? '1' : '0'); } catch { /* ignore */ } },
  play(name) {
    if (!this.enabled()) return;
    try {
      sounds[name] ||= new Audio(`/audio/${name}.mp3`);
      sounds[name].currentTime = 0;
      sounds[name].play().catch(() => {});
    } catch { /* missing file */ }
  },
};

export function fmtCount(n) { return n > 999 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n); }
