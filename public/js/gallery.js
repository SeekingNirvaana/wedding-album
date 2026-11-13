// Photo grid with endless scroll, and a full-screen viewer with swipe, pinch-zoom, download and share.
import { h, thumbUrl, viewUrl, dlUrl, toast, api, device, sound, haptic } from './core.js';
import { fill } from './core.js';
import { t } from './i18n.js';

// Tells the server a guest looked at / saved / shared a photo (unique per guest; used for Highlights suggestions)
const sent = new Set();
function track(id, kind) {
  const k = id + kind;
  if (sent.has(k)) return;
  sent.add(k);
  fetch(`/api/photos/${id}/engage`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }), keepalive: true }).catch(() => {});
}

export function createGallery({ mount, fetchPage, empty, canDelete, onDeleted, extraActions, mod = false }) {
  const grid = h('div', { class: 'grid' });
  const sentinel = h('div', { class: 'sentinel' });
  const photos = [];
  let next = undefined, loading = false, done = false;

  // ---- multi-select: long-press a photo or tap "Select" ----
  const selected = new Set();
  let selecting = false;
  const selBtn = h('button', { class: 'select-btn', hidden: true, onclick: () => (selecting ? exitSelect() : enterSelect()) }, t('select'));
  const tools = h('div', { class: 'grid-tools' }, selBtn);
  const bar = h('div', { class: 'sel-bar', role: 'toolbar' });
  fill(mount, tools, grid, sentinel);

  function enterSelect(first) {
    selecting = true; grid.classList.add('selecting'); selBtn.textContent = t('cancel'); haptic(15);
    document.body.append(bar); requestAnimationFrame(() => bar.classList.add('show'));
    if (first) toggle(first);
    renderBar();
  }
  function exitSelect() {
    selecting = false; selected.clear(); grid.classList.remove('selecting'); selBtn.textContent = t('select');
    grid.querySelectorAll('.tile.picked').forEach((el) => el.classList.remove('picked'));
    bar.classList.remove('show'); setTimeout(() => bar.remove(), 250);
  }
  function toggle(el) {
    const p = el._p;
    if (selected.has(p)) { selected.delete(p); el.classList.remove('picked'); } else { selected.add(p); el.classList.add('picked'); }
    haptic(6); renderBar();
  }
  function renderBar() {
    const list = [...selected];
    const n = list.length;
    const deletable = n && canDelete && list.every((p) => canDelete(p));
    const ready = list.filter((p) => p.status === 'ready');
    fill(bar,
      h('button', { class: 'sel-x', 'aria-label': t('cancel'), onclick: exitSelect }, '✕'),
      h('b', { class: 'sel-n' }, n ? `${n} ${t('selected')}` : t('tap_to_select')),
      h('button', { class: 'sel-act', onclick: selectAll }, t('select_all')),
      h('div', { class: 'sel-row' },
        h('button', { class: 'sel-act primary', disabled: !ready.length, onclick: () => (saveViaShare(ready.length) ? shareMany(ready) : download(ready)) }, '⤓ ' + t('download')),
        mod && n ? h('button', { class: 'sel-act', onclick: () => bulkAct('highlight', list) }, '★') : null,
        mod && n ? h('button', { class: 'sel-act', onclick: () => bulkAct('hide', list) }, t('hide')) : null,
        deletable ? h('button', { class: 'sel-act danger', onclick: () => bulkAct('delete', list) }, t('delete')) : null));
  }
  async function selectAll() {
    // load everything (up to 500) so "all" really means all
    while (!done && photos.length < 500) await load();
    grid.querySelectorAll('.tile').forEach((el) => { selected.add(el._p); el.classList.add('picked'); });
    renderBar();
  }
  // Phones: up to 20 photos go through the share sheet ("Save images" lands them in the gallery). Otherwise one zip.
  function saveViaShare(n) {
    const phone = /Android|iPhone|iPad/.test(navigator.userAgent);
    try { return phone && n <= 20 && navigator.canShare?.({ files: [new File([''], 'x.jpg', { type: 'image/jpeg' })] }); } catch { return false; }
  }
  async function download(list) {
    if (list.length === 1) { location.href = dlUrl(list[0].id); return; }
    // One zip per 100 photos, fetched one after another
    for (let k = 0; k < list.length; k += 100) {
      const ids = list.slice(k, k + 100).map((p) => p.id).join(',');
      const a = h('a', { href: `/api/photos/zip?ids=${ids}`, download: '' });
      document.body.append(a); a.click(); a.remove();
      if (k + 100 < list.length) await new Promise((r) => setTimeout(r, 2500));
    }
    list.forEach((p) => track(p.id, 'download'));
    toast(list.length > 100 ? t('zips_coming', { n: Math.ceil(list.length / 100) }) : t('zip_coming'));
  }
  async function shareMany(list) {
    let files;
    try {
      toast(t('preparing'));
      files = await Promise.all(list.map(async (p, k) => new File([await (await fetch(`/img/full/${p.id}.jpg`)).blob()], `anoop-sanghmitra-${k + 1}.jpg`, { type: 'image/jpeg' })));
    } catch { toast(t('offline')); return; }
    if (!navigator.canShare({ files })) return download(list);
    try { await navigator.share({ files }); list.forEach((p) => track(p.id, 'download')); exitSelect(); } catch { /* cancelled */ }
  }
  async function bulkAct(action, list) {
    if (action === 'delete' && !confirm(t('delete_many_q', { n: list.length }))) return;
    if (action === 'hide' && !confirm(t('hide_many_q', { n: list.length }))) return;
    try {
      await api('/api/photos/bulk', { method: 'POST', body: { action, ids: list.map((p) => p.id) } });
    } catch (e) { toast(e.message); return; }
    if (action === 'delete' || action === 'hide') {
      for (const p of list) { const k = photos.indexOf(p); if (k >= 0) photos.splice(k, 1); p._el?.remove(); }
      if (action === 'delete') list.forEach((p) => onDeleted?.(p));
      if (!photos.length && empty) fill(mount, empty());
    } else {
      list.forEach((p) => { p.highlight = true; if (!p._el.querySelector('.badge-star')) p._el.append(h('span', { class: 'badge-star', 'aria-hidden': 'true' })); });
    }
    sound.play(action === 'delete' ? 'tap' : 'bell');
    toast(t('done_n', { n: list.length }));
    exitSelect();
  }

  function tile(p, i) {
    const img = h('img', { src: thumbUrl(p.id), alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('load', () => img.classList.add('in'), { once: true });
    let pressTimer = null, longPressed = false;
    const el = h('button', { class: 'tile' + (p.status !== 'ready' ? ' pending' : ''), 'aria-label': 'Open photo', style: { '--d': `${(i % 15) * 35}ms` },
      onclick: (e) => {
        if (longPressed) { longPressed = false; return; }
        if (selecting) toggle(e.currentTarget); else openViewer(photos.indexOf(p), e.currentTarget);
      },
      onpointerdown: (e) => {
        longPressed = false; const target = e.currentTarget;
        pressTimer = setTimeout(() => { longPressed = true; if (selecting) toggle(target); else enterSelect(target); }, 450);
      },
      onpointerup: () => clearTimeout(pressTimer), onpointerleave: () => clearTimeout(pressTimer), onpointercancel: () => clearTimeout(pressTimer),
      oncontextmenu: (e) => e.preventDefault(),
    }, img, h('i', { class: 'pick', 'aria-hidden': 'true' }));
    el._p = p; p._el = el;
    if (p.highlight) el.append(h('span', { class: 'badge-star', 'aria-hidden': 'true' }));
    return el;
  }

  async function load() {
    if (loading || done) return;
    loading = true;
    grid.classList.add('loading');
    try {
      const res = await fetchPage(next);
      const start = photos.length;
      photos.push(...res.photos);
      grid.append(...res.photos.map((p, k) => tile(p, start + k)));
      next = res.next;
      if (!next) done = true;
      selBtn.hidden = !photos.length;
      if (!photos.length && empty) fill(mount, empty());
    } catch (e) {
      if (!photos.length) fill(mount, h('p', { class: 'muted center pad' }, e.message));
      done = true;
    } finally {
      loading = false;
      grid.classList.remove('loading');
    }
  }

  const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && load(), { rootMargin: '800px' });
  io.observe(sentinel);
  load();

  function openViewer(startIndex, fromEl) {
    let i = startIndex;
    sound.play('tap'); haptic(6);
    const img = h('img', { class: 'v-img', alt: '' });
    const counter = h('span', { class: 'v-count' });
    const stage = h('div', { class: 'v-stage' }, img);
    const actions = h('div', { class: 'v-actions' });
    const wrap = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'v-top' }, h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '✕'), counter),
      stage, actions);
    document.body.append(wrap);
    document.body.classList.add('noscroll');
    history.pushState({ viewer: true }, '');
    const onPop = () => close(true);
    window.addEventListener('popstate', onPop);

    let first = true;
    function render() {
      const p = photos[i];
      zoom = 1; tx = ty = 0; apply();
      // Show the (already cached) thumbnail at once, then swap in the sharper version when it arrives
      img.classList.add('in');
      img.src = thumbUrl(p.id);
      const big = new Image();
      big.onload = () => { if (photos[i] === p) img.src = big.src; };
      big.src = viewUrl(p.id);
      if (first && fromEl && !device.lite) {
        first = false;
        const r = fromEl.getBoundingClientRect();
        requestAnimationFrame(() => {
          const s = stage.getBoundingClientRect();
          const size = Math.min(s.width, s.height);
          const k = r.width / size;
          img.animate([
            { transform: `translate(${r.left + r.width / 2 - (s.left + s.width / 2)}px, ${r.top + r.height / 2 - (s.top + s.height / 2)}px) scale(${k})`, borderRadius: '12px' },
            { transform: 'translate(0,0) scale(1)', borderRadius: '0px' },
          ], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
        });
      } else if (!first) {
        img.animate([{ opacity: 0.4, transform: 'scale(.97)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 220, easing: 'ease-out' });
      }
      first = false;
      counter.textContent = `${i + 1} / ${photos.length}${next ? '+' : ''}`;
      if (p.status === 'ready') track(p.id, 'view');
      fill(actions, 
        h('a', { class: 'pill-btn', href: dlUrl(p.id), download: '', onclick: () => track(p.id, 'download') }, t('download')),
        navigator.canShare ? h('button', { class: 'pill-btn', onclick: () => share(p) }, t('share')) : null,
        ...(extraActions ? extraActions(p, refreshTile) : []),
        canDelete && canDelete(p) ? h('button', { class: 'pill-btn danger', onclick: () => remove(p) }, t('delete')) : null,
      );
      if (i > photos.length - 6 && !done) load();
    }
    function refreshTile() { render(); }
    function go(d) { const j = i + d; if (j >= 0 && j < photos.length) { i = j; render(); } }
    function close(fromPop) {
      window.removeEventListener('popstate', onPop);
      wrap.remove(); document.body.classList.remove('noscroll');
      document.removeEventListener('keydown', onKey);
      if (!fromPop) history.back();
    }
    async function share(p) {
      try {
        const blob = await (await fetch(`/img/full/${p.id}.jpg`)).blob();
        const file = new File([blob], `anoop-sanghmitra-${p.id.slice(0, 8)}.jpg`, { type: 'image/jpeg' });
        if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); track(p.id, 'share'); }
      } catch { /* cancelled */ }
    }
    async function remove(p) {
      if (!confirm(t('delete_q'))) return;
      try {
        await api(`/api/photos/${p.id}`, { method: 'DELETE' });
        const k = photos.indexOf(p); photos.splice(k, 1); p._el?.remove();
        onDeleted?.(p);
        if (!photos.length) return close();
        i = Math.min(i, photos.length - 1); render();
      } catch (e) { toast(e.message); }
    }

    // gestures: swipe to navigate, pinch / double-tap to zoom, drag when zoomed
    let zoom = 1, tx = 0, ty = 0, start = null, pinch = null, lastTap = 0;
    const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`; };
    stage.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        const [a, b] = e.touches; pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: zoom };
      } else {
        const tt = e.touches[0]; start = { x: tt.clientX, y: tt.clientY, tx, ty, time: Date.now() };
        if (Date.now() - lastTap < 280) { zoom = zoom > 1 ? 1 : 2.5; tx = ty = 0; apply(); }
        lastTap = Date.now();
      }
    }, { passive: true });
    stage.addEventListener('touchmove', (e) => {
      if (pinch && e.touches.length === 2) {
        const [a, b] = e.touches; zoom = Math.max(1, Math.min(4, pinch.z * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d)); apply();
      } else if (start && zoom > 1) {
        const tt = e.touches[0]; tx = start.tx + tt.clientX - start.x; ty = start.ty + tt.clientY - start.y; apply();
      }
    }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      if (pinch) { pinch = null; if (zoom < 1.05) { zoom = 1; tx = ty = 0; apply(); } return; }
      if (!start || zoom > 1) { start = null; return; }
      const tt = e.changedTouches[0]; const dx = tt.clientX - start.x, dy = tt.clientY - start.y;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) go(dx < 0 ? 1 : -1);
      else if (dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.4) close();
      start = null;
    });
    const onKey = (e) => { if (e.key === 'ArrowRight') go(1); else if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    render();
  }

  return { reload() { if (selecting) exitSelect(); photos.length = 0; next = undefined; done = false; grid.replaceChildren(); fill(mount, tools, grid, sentinel); load(); }, photos, exitSelect };
}
