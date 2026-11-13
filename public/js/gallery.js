// Photo grid with endless scroll, and a full-screen viewer with swipe, pinch-zoom, download and share.
import { h, thumbUrl, viewUrl, dlUrl, toast, api } from './core.js';
import { fill } from './core.js';
import { t } from './i18n.js';

export function createGallery({ mount, fetchPage, empty, canDelete, onDeleted, extraActions }) {
  const grid = h('div', { class: 'grid' });
  const sentinel = h('div', { class: 'sentinel' });
  const photos = [];
  let next = undefined, loading = false, done = false;

  fill(mount, grid, sentinel);

  function tile(p, i) {
    const img = h('img', { src: thumbUrl(p.id), alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('load', () => img.classList.add('in'), { once: true });
    const el = h('button', { class: 'tile' + (p.status !== 'ready' ? ' pending' : ''), 'aria-label': 'Open photo', onclick: () => openViewer(i) }, img);
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

  function openViewer(startIndex) {
    let i = startIndex;
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

    function render() {
      const p = photos[i];
      zoom = 1; tx = ty = 0; apply();
      img.classList.remove('in');
      img.src = viewUrl(p.id);
      img.onload = () => img.classList.add('in');
      counter.textContent = `${i + 1} / ${photos.length}${next ? '+' : ''}`;
      fill(actions, 
        h('a', { class: 'pill-btn', href: dlUrl(p.id), download: '' }, t('download')),
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
        if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
      } catch { /* cancelled */ }
    }
    async function remove(p) {
      if (!confirm(t('delete_q'))) return;
      try {
        await api(`/api/photos/${p.id}`, { method: 'DELETE' });
        const k = photos.indexOf(p); photos.splice(k, 1); grid.children[k]?.remove();
        [...grid.children].forEach((el, n) => { el.onclick = () => openViewer(n); });
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

  return { reload() { photos.length = 0; next = undefined; done = false; grid.replaceChildren(); fill(mount, grid, sentinel); load(); }, photos };
}
