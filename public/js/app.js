import { api, ApiError, h, toast, sheet, petals, sound, device, net, cropUrl, fmtCount, haptic } from './core.js';
import { toran, mandala, templeDoors, floatingDiyas, embers, letters, burst, ripple, petalRing } from './fx.js';
import { fill } from './core.js';
import { t, getLang, setLang } from './i18n.js';
import { createGallery } from './gallery.js';
import * as uploader from './uploader.js';
import { liveCapture, stillsCapture, cameraSupported } from './camera.js';

const app = document.getElementById('app');
const state = { config: null, me: null, tab: 'you', filter: { event: '', side: '' }, scope: 'me' };
if (device.lite) document.documentElement.classList.add('lite');
setLang(getLang());

// ---------------- boot ----------------
async function boot() {
  try {
    state.config = await api('/api/config');
    uploader.setConfig(state.config);
  } catch {
    fill(app, h('div', { class: 'center pad' }, h('p', {}, t('offline'))));
    return;
  }
  await refreshMe();
}

async function refreshMe() {
  try {
    state.me = await api('/api/me');
  } catch (e) {
    if (e.status === 401) return renderGate();
    throw e;
  }
  if (!state.me.user.enrolled) return renderFaceSetup();
  renderShell();
  uploader.kick();
}

// ---------------- gate & sign-in ----------------
function garland() { return toran(device.lite ? 10 : 18); }

function renderGate() {
  const c = state.config;
  let seen = false; try { seen = sessionStorage.getItem('wa_doors') === '1'; sessionStorage.setItem('wa_doors', '1'); } catch { /* */ }
  const doors = seen ? null : templeDoors();
  const d0 = seen ? 0 : 1.1; // text starts once the doors are half open
  const enter = h('button', { class: 'btn primary glow shine', onclick: (e) => { ripple(e); haptic(15); sound.play('welcome'); openSignIn(); } }, t('enter'));
  fill(app, h('main', { class: 'gate' + (seen ? ' seen' : '') },
    h('div', { class: 'gate-art', 'aria-hidden': 'true' }),
    h('div', { class: 'gate-sky', 'aria-hidden': 'true' }, h('i', { class: 'moon' }), ...Array.from({ length: device.lite ? 0 : 18 }, (_, i) => h('b', { class: 'star', style: { left: `${(i * 53) % 100}%`, top: `${(i * 29) % 38}%`, animationDelay: `${(i * 0.7) % 5}s` } }))),
    ...embers(), ...floatingDiyas(),
    garland(),
    h('div', { class: 'gate-inner' },
      device.lite ? null : mandala({ cls: 'mandala gate-mandala' }),
      h('p', { class: 'dev-line rise', style: { animationDelay: d0 + 's' } }, '॥ शुभ विवाह ॥'),
      h('p', { class: 'eyebrow rise', style: { animationDelay: d0 + 0.2 + 's' } }, t('album')),
      h('h1', { class: 'names' },
        h('span', { class: 'nm' }, ...letters('Anoop', d0 + 0.35)),
        h('span', { class: 'weds rise', style: { animationDelay: d0 + 0.75 + 's' } }, 'weds'),
        h('span', { class: 'nm' }, ...letters('Sanghmitra', d0 + 0.9, 0.05)),
        h('i', { class: 'name-shine', 'aria-hidden': 'true', style: { animationDelay: d0 + 1.8 + 's' } })),
      h('p', { class: 'gate-sub rise', style: { animationDelay: d0 + 1.5 + 's' } }, c.subtitle),
      h('p', { class: 'gate-lede rise', style: { animationDelay: d0 + 1.7 + 's' } }, t('gate_sub')),
      h('div', { class: 'rise', style: { animationDelay: d0 + 1.95 + 's' } }, enter),
      h('button', { class: 'lang-switch rise', style: { animationDelay: d0 + 2.1 + 's' }, onclick: () => { setLang(getLang() === 'hi' ? 'en' : 'hi'); renderGate(); } }, getLang() === 'hi' ? 'English' : 'हिन्दी'),
    ),
    doors,
  ));
  sound.preload();
}

let turnstileLoaded = null;
function loadScript(src) {
  return new Promise((res, rej) => { const s = h('script', { src, async: true }); s.onload = res; s.onerror = rej; document.head.append(s); });
}

function openSignIn() {
  const c = state.config;
  let side = 'groom', token = '', tsError = '';
  const waiters = [];
  const setToken = (v) => { token = v; tsError = ''; while (waiters.length) waiters.shift()(v); };
  const waitForToken = (ms) => token ? Promise.resolve(token) : new Promise((res) => { waiters.push(res); setTimeout(() => res(token), ms); });
  const name = h('input', { class: 'field', autocomplete: 'name', maxlength: 40, placeholder: t('your_name') });
  const phone = h('input', { class: 'field', type: 'tel', inputmode: 'numeric', autocomplete: 'tel-national', maxlength: 14, placeholder: '98765 43210' });
  const sideCard = (key, art) => h('button', { type: 'button', class: 'side-card' + (side === key ? ' on' : ''), 'data-side': key, onclick: (e) => {
    side = key; e.currentTarget.parentElement.querySelectorAll('.side-card').forEach((b) => b.classList.toggle('on', b.dataset.side === key));
    sound.play('tap'); haptic(8);
  } }, h('span', { class: 'side-art', style: { backgroundImage: `url(${art})` } }), h('i', { class: 'side-tick', 'aria-hidden': 'true' }), h('b', {}, t(key + '_side')), h('small', {}, c.sides[key].place));
  const consent = h('input', { type: 'checkbox', id: 'consent' });
  const ts = h('div', { class: 'ts-box' });
  const err = h('p', { class: 'err', role: 'alert' });
  const send = h('button', { class: 'btn primary wide', type: 'submit' }, t('send_code'));
  const form = h('form', { class: 'signin', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    if (!consent.checked) { err.textContent = t('consent'); return; }
    send.disabled = true;
    try {
      if (c.turnstileSiteKey && !token) {
        if (tsError) throw new Error(t('check_failed') + ' (' + tsError + ')');
        send.textContent = t('checking');
        if (window.turnstile && ts.dataset.wid) { try { window.turnstile.execute(ts.dataset.wid); } catch {} }
        token = await waitForToken(12000);
        send.textContent = t('send_code');
        if (!token) throw new Error(tsError ? t('check_failed') + ' (' + tsError + ')' : t('check_slow'));
      }
      const res = await api('/api/auth/start', { method: 'POST', body: { phone: phone.value, turnstile: token } });
      if (res.provider === 'firebase') await firebaseFlow(s, phone.value, name.value, side);
      else otpStep(s, res, phone.value, name.value, side);
    } catch (e2) {
      err.textContent = e2.message; send.disabled = false; send.textContent = t('send_code');
      if (window.turnstile && ts.dataset.wid) { window.turnstile.reset(ts.dataset.wid); token = ''; }
    }
  } },
    h('h2', {}, t('enter')),
    h('label', {}, t('your_name'), name),
    h('label', {}, t('mobile'), h('div', { class: 'phone-row' }, h('span', { class: 'cc' }, '+91'), phone)),
    h('p', { class: 'label' }, t('i_am_with')),
    h('div', { class: 'side-row' }, sideCard('groom', '/art/hero-kashi.webp'), sideCard('bride', '/art/sangam-dawn.webp')),
    h('label', { class: 'check' }, consent, h('span', {}, t('consent'))),
    ts, err, send, h('p', { class: 'sms-note' }, t('sms_from')));
  send.addEventListener('pointerdown', ripple);
  const s = sheet(form);
  setTimeout(() => name.focus(), 350);
  if (c.turnstileSiteKey) {
    turnstileLoaded ||= loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
    turnstileLoaded.then(() => {
      ts.dataset.wid = window.turnstile.render(ts, { sitekey: c.turnstileSiteKey, size: 'flexible', appearance: 'interaction-only',
        callback: setToken, 'expired-callback': () => { token = ''; },
        'error-callback': (code) => { tsError = String(code || 'error'); while (waiters.length) waiters.shift()(''); return true; } });
    }).catch(() => { err.textContent = t('offline'); });
  }
}

function otpStep(s, res, phoneVal, nameVal, side) {
  const code = h('input', { class: 'field otp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]*', placeholder: '••••••' });
  const err = h('p', { class: 'err', role: 'alert' });
  const resend = h('button', { type: 'button', class: 'link-btn', disabled: true });
  let left = res.resendAfter || 30;
  const tick = setInterval(() => {
    left--; resend.textContent = left > 0 ? `${t('resend_in')} ${left}s` : t('resend'); resend.disabled = left > 0;
    if (left <= 0) clearInterval(tick);
  }, 1000);
  resend.textContent = `${t('resend_in')} ${left}s`;
  resend.onclick = () => { clearInterval(tick); s.close(); openSignIn(); };
  const btn = h('button', { class: 'btn primary wide', type: 'submit' }, t('verify'));
  const form = h('form', { class: 'signin', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; btn.disabled = true;
    try {
      await api('/api/auth/verify', { method: 'POST', body: { requestId: res.requestId, code: code.value, name: nameVal, side, consent: true } });
      clearInterval(tick); haptic([10, 40, 10]); sound.play('bell');
      const r = btn.getBoundingClientRect(); burst({ x: r.left + r.width / 2, y: r.top, n: 20 });
      setTimeout(async () => { s.close(); await refreshMe(); }, 650);
    } catch (e2) {
      err.textContent = e2.message; btn.disabled = false;
      if (e2.data?.code === 'expired') { resend.disabled = false; resend.textContent = t('resend'); }
    }
  } },
    h('h2', {}, t('verify')),
    h('p', { class: 'muted' }, `${t('enter_code')} +91 ${phoneVal.replace(/\D/g, '').slice(-10)}`),
    h('div', { class: 'otp-wrap' }, code, h('div', { class: 'otp-boxes', 'aria-hidden': 'true' }, ...Array.from({ length: 6 }, () => h('i')))), err, btn,
    h('div', { class: 'row-between' }, resend, h('button', { type: 'button', class: 'link-btn', onclick: () => { clearInterval(tick); s.close(); openSignIn(); } }, t('change_number'))));
  fill(s.panel, h('div', { class: 'grab' }), form);
  const boxes = form.querySelectorAll('.otp-boxes i');
  code.addEventListener('input', () => {
    code.value = code.value.replace(/\D/g, '').slice(0, 6);
    boxes.forEach((b, i) => { b.textContent = code.value[i] || ''; b.classList.toggle('on', i < code.value.length); b.classList.toggle('cur', i === code.value.length); });
    if (code.value.length) haptic(5);
    if (code.value.length === 6) form.requestSubmit();
  });
  code.addEventListener('focus', () => code.dispatchEvent(new Event('input')));
  setTimeout(() => code.focus(), 100);
}

async function firebaseFlow(s, phoneVal, nameVal, side) {
  const fb = state.config.firebase;
  const v = '13.3.0';
  const [{ initializeApp }, auth] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${v}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${v}/firebase-auth.js`),
  ]);
  const fapp = initializeApp({ apiKey: fb.apiKey, authDomain: `${fb.projectId}.firebaseapp.com`, projectId: fb.projectId });
  const a = auth.getAuth(fapp);
  const holder = h('div', { id: 'fb-recaptcha' });
  document.body.append(holder);
  const verifier = new auth.RecaptchaVerifier(a, holder, { size: 'invisible' });
  const confirmation = await auth.signInWithPhoneNumber(a, '+91' + phoneVal.replace(/\D/g, '').slice(-10), verifier);
  otpStep(s, { requestId: null, resendAfter: 60 }, phoneVal, nameVal, side);
  const form = s.panel.querySelector('form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = form.querySelector('.err'); err.textContent = '';
    try {
      const cred = await confirmation.confirm(form.querySelector('.otp').value);
      const idToken = await cred.user.getIdToken();
      await api('/api/auth/firebase', { method: 'POST', body: { idToken, name: nameVal, side, consent: true } });
      await auth.signOut(a);
      s.close(); await refreshMe();
    } catch (e2) { err.textContent = e2.message || 'Wrong code'; }
  };
}

// ---------------- face setup ----------------
function renderFaceSetup(purpose = 'self', label = null, onDone = null) {
  const body = h('div', { class: 'face-body' });
  const intro = h('div', { class: 'face-intro' },
    h('div', { class: 'face-illus', 'aria-hidden': 'true' }, mandala({ cls: 'mandala face-mandala', rings: [[12, 72, 20], [20, 94, 14]] }), h('i', { class: 'fi-face' }), h('b', { class: 'fi-scan' })),
    h('h2', {}, purpose === 'self' ? t('face_title') : t('add_family')),
    purpose === 'self' ? null : h('p', {}, t('family_body')),
    h('ol', { class: 'face-steps' }, h('li', {}, h('span', {}, '1'), t('step_look')), h('li', {}, h('span', {}, '2'), t('step_turn')), h('li', {}, h('span', {}, '3'), t('step_done'))),
    h('p', { class: 'muted small' }, t('face_private')));
  const startBtn = h('button', { class: 'btn primary wide glow', onclick: () => run(cameraSupported() ? 'live' : 'stills') }, t('start_camera'));
  const alt = h('button', { class: 'link-btn', onclick: () => run('stills') }, t('use_photos_instead'));
  fill(body, intro, startBtn, alt);
  const screen = h('main', { class: 'face-screen' }, garland(), body);
  if (purpose === 'self') fill(app, screen); else { const s = sheet(screen); onDone = ((orig) => () => { s.close(); orig?.(); })(onDone); }

  async function run(mode) {
    let ch;
    try {
      ch = await api('/api/enroll/challenge', { method: 'POST', body: { purpose, label } });
    } catch (e) { toast(e.message); return; }
    const stage = h('div', { class: 'face-stage' });
    fill(body, stage);
    let cap;
    try {
      cap = mode === 'live' ? await liveCapture(stage, ch.sequence) : await stillsCapture(stage, ch.sequence);
    } catch (e) {
      if (e.code === 'camera_blocked') {
        fill(body, h('p', { class: 'center' }, t('camera_blocked')),
          isInAppBrowser() ? h('a', { class: 'btn primary wide', href: openInBrowserUrl() }, t('open_in_browser')) : null,
          h('button', { class: 'btn wide', onclick: () => run('stills') }, t('use_photos_instead')));
      } else fill(body, intro, startBtn, alt);
      return;
    }
    const msg = h('p', { class: 'think-msg' }, t('think_1'));
    fill(body, h('div', { class: 'thinking' }, h('div', { class: 'rangoli-load', 'aria-hidden': 'true' }, mandala({ cls: 'mandala spin-slow', rings: [[16, 90, 26], [10, 60, 22]] }), h('i')), msg));
    let mi = 1; const cycle = setInterval(() => { msg.classList.remove('swap'); void msg.offsetWidth; msg.classList.add('swap'); msg.textContent = t('think_' + (1 + (mi++ % 3))); }, 2200);
    try {
      const res = await api('/api/enroll/submit', { method: 'POST', body: { challengeId: ch.challengeId, frames: cap.frames, mode: cap.mode } });
      clearInterval(cycle);
      if (!res.ok) throw new ApiError(400, { error: t('reason_' + res.reason) });
      sound.play('found'); haptic([20, 60, 20, 60, 40]); burst({ n: 36 }); setTimeout(() => petals(24), 300);
      const who = purpose === 'self' ? (state.me?.user?.name || '') : label;
      fill(body, h('div', { class: 'face-done' },
        h('div', { class: 'bloom', 'aria-hidden': 'true' }, mandala({ cls: 'mandala bloom-m', rings: [[16, 92, 30], [12, 60, 24]] }), h('div', { class: 'tick' })),
        h('h2', {}, purpose === 'self' ? `${t('welcome')}, ${who}` : `${who} ✓`),
        h('p', { class: 'muted' }, t('face_ok'))));
      setTimeout(() => (onDone ? onDone() : refreshMe()), 2600);
    } catch (e) {
      clearInterval(cycle); haptic([40, 40, 40]);
      fill(body, h('div', { class: 'face-fail' }, h('div', { class: 'fail-diya', 'aria-hidden': 'true' }, h('i', { class: 'flame' }), h('b', { class: 'bowl' })),
        h('p', { class: 'err center' }, e.message), h('p', { class: 'muted small' }, t('retry_tips'))),
        h('button', { class: 'btn primary wide', onclick: () => run(mode) }, t('try_again')));
    }
  }
}

function isInAppBrowser() { return /FBAN|FBAV|Instagram|Line\/|; wv\)/.test(navigator.userAgent); }
function openInBrowserUrl() {
  const u = location.href.replace(/^https?:\/\//, '');
  return /Android/.test(navigator.userAgent) ? `intent://${u}#Intent;scheme=https;package=com.android.chrome;end` : location.href;
}

// ---------------- main shell ----------------
const TABS = [
  ['you', 'for_you', 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0'],
  ['highlights', 'highlights', 'M12 3l2.6 5.6 6 .7-4.5 4.1 1.3 6L12 16.4 6.6 19.4l1.3-6L3.4 9.3l6-.7Z'],
  ['upload', 'upload', ''],
  ['mine', 'my_uploads', 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4'],
  ['profile', 'profile', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5v4l3 2'],
];

function icon(d) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d); svg.append(p);
  return svg;
}

let content, navEl, banner;
function renderShell() {
  content = h('section', { class: 'content' });
  banner = h('div', { class: 'net-banner', hidden: true });
  navEl = h('nav', { class: 'bottom-nav' }, TABS.map(([key, label, d]) => key === 'upload'
    ? h('button', { class: 'shutter', 'aria-label': t('upload'), onclick: (e) => { ripple(e); haptic(12); openUpload(); } }, h('span'), h('em', { class: 'halo', 'aria-hidden': 'true' }))
    : h('button', { class: 'nav-btn', 'data-tab': key, onclick: () => { if (state.tab !== key) { sound.play('tap'); haptic(6); } switchTab(key); } }, icon(d), h('small', {}, t(label)))),
    h('i', { class: 'nav-ink', 'aria-hidden': 'true' }));
  fill(app, h('header', { class: 'top' },
    h('div', {}, h('p', { class: 'dev-line small' }, '॥ शुभ विवाह ॥'), h('p', { class: 'top-names' }, 'Anoop & Sanghmitra')),
    h('button', { class: 'avatar', 'aria-label': t('profile'), onclick: () => switchTab('profile') }, (state.me.user.name || 'G').slice(0, 1).toUpperCase())),
  banner, content, navEl);
  switchTab(state.tab);
  updateBanner();
}

function updateBanner() {
  if (!banner) return;
  uploader.pendingCount().then((n) => {
    if (!net.online() && n) { banner.hidden = false; banner.textContent = t('net_offline'); }
    else if (n && (net.tier() === 'slow' || net.tier() === 'poor')) { banner.hidden = false; banner.textContent = t('net_slow'); }
    else if (n && device.ios) { banner.hidden = false; banner.textContent = t('keep_open'); }
    else banner.hidden = true;
  });
}
window.addEventListener('resize', () => { if (navEl) switchInk(); });
function switchInk() { const on = navEl.querySelector('.nav-btn.on'), ink = navEl.querySelector('.nav-ink'); if (on && ink) ink.style.transform = `translateX(${on.offsetLeft + on.offsetWidth / 2 - 14}px)`; }
window.addEventListener('online', updateBanner); window.addEventListener('offline', updateBanner);
net.on(updateBanner);

function switchTab(key) {
  state.tab = key;
  navEl?.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('on', b.dataset.tab === key));
  const on = navEl?.querySelector('.nav-btn.on'), ink = navEl?.querySelector('.nav-ink');
  if (ink) { if (on) { ink.style.opacity = '1'; ink.style.transform = `translateX(${on.offsetLeft + on.offsetWidth / 2 - 14}px)`; } else ink.style.opacity = '0'; }
  content.classList.remove('enter'); void content.offsetWidth; content.classList.add('enter');
  if (key === 'you') renderYou();
  else if (key === 'highlights') renderListTab('highlights', t('highlights'));
  else if (key === 'mine') renderMine();
  else if (key === 'profile') renderProfile();
  window.scrollTo({ top: 0 });
}

// filters: event chips (with art) + side toggle when the event happened on both sides
function filters(onChange) {
  const ev = state.config.events;
  const sideRow = h('div', { class: 'side-toggle' });
  const chips = h('div', { class: 'chips', role: 'tablist' },
    h('button', { class: 'chip' + (!state.filter.event ? ' on' : ''), onclick: () => pick('') }, t('all_events')),
    ev.map((e) => h('button', { class: 'chip' + (state.filter.event === e.id ? ' on' : ''), 'data-ev': e.id, onclick: () => pick(e.id) },
      e.art ? h('span', { class: 'chip-art', style: { backgroundImage: `url(${e.art})` } }) : null, e.name)));
  function renderSides() {
    const e = ev.find((x) => x.id === state.filter.event);
    if (!e || e.sides.length < 2) { sideRow.replaceChildren(); state.filter.side = ''; return; }
    const opt = (v, label) => h('button', { class: 'seg' + (state.filter.side === v ? ' on' : ''), onclick: () => { state.filter.side = v; renderSides(); onChange(); } }, label);
    fill(sideRow, opt('', t('everyone')), ...e.sides.map((s) => opt(s, `${state.config.sides[s].label} · ${state.config.sides[s].place}`)));
  }
  function pick(id) {
    state.filter.event = id; state.filter.side = '';
    chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', (c.dataset.ev || '') === id));
    renderSides(); onChange();
  }
  renderSides();
  return h('div', { class: 'filters' }, chips, sideRow);
}

function pager(scope) {
  return async (cursor) => {
    const q = new URLSearchParams({ scope, limit: '60' });
    if (state.filter.event) q.set('event', state.filter.event);
    if (state.filter.side) q.set('side', state.filter.side);
    if (cursor) q.set('cursor', cursor);
    return api('/api/photos?' + q);
  };
}

async function renderYou() {
  const me = state.me;
  const head = h('div', { class: 'hello' },
    h('p', { class: 'eyebrow' }, `${t('hi')}, ${me.user.name}`),
    h('h2', { class: 'big-title' }, t('found_you')),
    h('p', { class: 'count-line' }, h('b', { class: 'count' }, '…'), ' ', h('span', { class: 'count-word' }, t('photos_word'))));
  const people = h('div', { class: 'people' },
    h('button', { class: 'person on', 'data-scope': 'me', onclick: () => setScope('me') }, h('span', { class: 'p-dot' }, (me.user.name || 'Y')[0]), me.user.name),
    me.family.filter((f) => f.status === 'active').map((f) => h('button', { class: 'person', 'data-scope': 'group:' + f.id, onclick: () => setScope('group:' + f.id) }, h('span', { class: 'p-dot' }, (f.label || 'F')[0]), f.label)));
  const confirmBar = me.pendingConfirmations ? h('button', { class: 'confirm-bar', onclick: openConfirm },
    h('span', { class: 'pulse', 'aria-hidden': 'true' }), `${me.pendingConfirmations} ${t('might_be_you')}`, h('b', {}, t('check_now'))) : null;
  const gal = h('div');
  state.scope = 'me';
  const g = () => createGallery({ mount: gal, fetchPage: pager(state.scope), empty: () => emptyState(t('none_yet')), canDelete: (p) => p.mine || state.me.isAdmin, extraActions: modActions });
  let gallery;
  function setScope(s) { state.scope = s; people.querySelectorAll('.person').forEach((b) => b.classList.toggle('on', b.dataset.scope === s)); gallery = g(); }
  fill(content, head, me.family.length ? people : null, confirmBar, filters(() => (gallery = g())), gal);
  gallery = g();
  try {
    const { counts } = await api('/api/counts?scope=me');
    const total = counts.reduce((a, c) => a + c.n, 0);
    countUp(head.querySelector('.count'), total);
    let seen = 0; try { seen = Number(localStorage.getItem('wa_seen') || 0); } catch { /* */ }
    if (total > 0) head.classList.add('has');
    if (total > seen && seen >= 0 && total > 0) {
      setTimeout(() => { const r = head.querySelector('.count').getBoundingClientRect(); burst({ x: r.left + r.width / 2, y: r.top + r.height / 2, n: 24 }); petals(16); sound.play('found'); haptic([15, 50, 15]); }, 700);
      if (total - seen > 0 && seen > 0) head.querySelector('.count-line').append(h('span', { class: 'new-pill' }, `+${total - seen} ${t('new')}`));
    }
    try { localStorage.setItem('wa_seen', String(total)); } catch { /* */ }
  } catch { head.querySelector('.count').textContent = ''; }
}

function countUp(el, n) {
  if (device.lite || n < 2) { el.textContent = fmtCount(n); return; }
  const t0 = performance.now();
  const step = (now) => { const k = Math.min(1, (now - t0) / 900); el.textContent = fmtCount(Math.round(n * (1 - (1 - k) ** 3))); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

// Helpers and admins can star or hide straight from the photo viewer
function modActions(p, refresh) {
  if (!state.me.canModerate) return [];
  const patch = async (body, msg) => {
    try { await api(`/api/mod/photos/${p.id}`, { method: 'PATCH', body }); Object.assign(p, body); toast(msg); sound.play('tap'); refresh(); } catch (e) { toast(e.message); }
  };
  return [
    h('button', { class: 'pill-btn', onclick: () => patch({ highlight: !p.highlight }, p.highlight ? t('removed_highlight') : t('added_highlight')) }, p.highlight ? '★ ' + t('unstar') : '☆ ' + t('star')),
    h('button', { class: 'pill-btn danger', onclick: () => confirm(t('hide_q')) && patch({ hidden: true }, t('hidden_done')) }, t('hide')),
  ];
}

function emptyState(text) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-art', 'aria-hidden': 'true' }), h('p', {}, text));
}

function renderListTab(scope, title) {
  const gal = h('div');
  let gallery;
  // Family / inner circle / helpers can switch between Highlights and everything they are allowed to see
  const wide = state.me.access && state.me.access !== 'guest';
  let cur = scope;
  const g = () => createGallery({ mount: gal, fetchPage: pager(cur), empty: () => emptyState(t('none_yet')), canDelete: (p) => p.mine || state.me.isAdmin, extraActions: modActions });
  const tabs = wide ? h('div', { class: 'scope-toggle' },
    [['highlights', t('highlights')], ['all', state.me.access === 'family' ? t('your_side_all') : t('all_photos')]].map(([k, label]) =>
      h('button', { class: 'seg' + (k === cur ? ' on' : ''), 'data-k': k, onclick: (e) => {
        cur = k; e.currentTarget.parentElement.querySelectorAll('.seg').forEach((b) => b.classList.toggle('on', b.dataset.k === k)); sound.play('tap'); gallery = g();
      } }, label))) : null;
  fill(content, h('div', { class: 'hello' }, h('h2', { class: 'big-title' }, title), tabs), filters(() => (gallery = g())), gal);
  gallery = g();
}

async function renderMine() {
  const queue = h('div', { class: 'queue' });
  const gal = h('div');
  fill(content, h('div', { class: 'hello' }, h('h2', { class: 'big-title' }, t('my_uploads'))), queue, gal);
  let gallery = createGallery({ mount: gal, fetchPage: pager('mine'), empty: () => emptyState(t('choose_photos')), canDelete: () => true });
  let lastDone = 0;
  const off = uploader.onChange((items, live) => {
    if (state.tab !== 'mine') { off(); return; }
    const active = items.filter((i) => i.status !== 'done');
    const done = items.filter((i) => i.status === 'done').length;
    fill(queue, active.length ? h('div', { class: 'queue-card' },
      h('p', { class: 'eyebrow' }, `${t('queue_title')} · ${active.length}`),
      h('div', { class: 'queue-list' }, active.slice(0, 30).map((i) => {
        const p = live.get(i.id)?.progress;
        const ring = h('div', { class: 'ring' });
        ring.style.setProperty('--p', String(Math.round((p || 0) * 100)));
        return h('div', { class: 'q-item ' + i.status, title: i.error || '' }, ring,
          h('small', {}, i.status === 'uploading' ? t('sending') : i.status === 'failed' ? t('failed') : i.status === 'error' ? (i.error || t('failed')) : t('queued')));
      }))) : null);
    if (done > lastDone) { lastDone = done; sound.play('bell'); gallery.reload(); }
    updateBanner();
  });
  uploader.items().then((items) => { lastDone = items.filter((i) => i.status === 'done').length; });
  uploader.kick();
}

function openUpload() {
  if (!state.me.uploadsOpen) { toast('Uploads are closed'); return; }
  const c = state.config;
  const cam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden' });
  const pick = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'visually-hidden' });
  const evSel = h('select', { class: 'field' }, h('option', { value: 'auto' }, t('auto_event')), c.events.map((e) => h('option', { value: e.id }, `${e.name} · ${e.when}`)));
  const sideSel = h('select', { class: 'field' }, ['groom', 'bride', 'joint'].map((s) => h('option', { value: s, selected: s === state.me.user.side }, `${c.sides[s].label} · ${c.sides[s].place}`)));
  const wifi = h('input', { type: 'checkbox', checked: uploader.prefs.wifiOnly, onchange: (e) => { uploader.prefs.wifiOnly = e.target.checked; } });
  const better = h('input', { type: 'checkbox', checked: uploader.prefs.betterLater, onchange: (e) => { uploader.prefs.betterLater = e.target.checked; } });
  const s = sheet(h('div', { class: 'upload-sheet' },
    h('h2', {}, t('upload')),
    h('div', { class: 'big-actions' },
      h('button', { class: 'big-act cam', onclick: () => cam.click() }, h('span', { class: 'lens', 'aria-hidden': 'true' }), t('take_photo')),
      h('button', { class: 'big-act gal', onclick: () => pick.click() }, h('span', { class: 'stack', 'aria-hidden': 'true' }), t('choose_photos'))),
    h('details', { class: 'opts' }, h('summary', {}, `${t('event')} · ${t('side')}`),
      h('label', {}, t('event'), evSel), h('label', {}, t('side'), sideSel),
      h('label', { class: 'check' }, wifi, h('span', {}, t('wifi_only'))),
      h('label', { class: 'check' }, better, h('span', {}, t('better_later')))),
    cam, pick));
  const go = async (files) => {
    if (!files.length) return;
    s.close();
    sound.play('shutter'); haptic([8, 30, 8]);
    await uploader.add([...files], { event: evSel.value, side: sideSel.value, mySide: state.me.user.side });
    switchTab('mine');
  };
  cam.addEventListener('change', () => go(cam.files));
  pick.addEventListener('change', () => go(pick.files));
}

async function openConfirm() {
  const { candidates } = await api('/api/candidates');
  const list = h('div', { class: 'confirm-grid' });
  const s = sheet(h('div', {}, h('h2', {}, t('is_this_you')), list));
  const render = () => fill(list, ...candidates.map((c) => h('div', { class: 'c-card' },
    h('img', { src: cropUrl(c.faceId), alt: '', loading: 'lazy' }),
    c.who !== 'you' ? h('small', {}, c.who) : null,
    h('div', { class: 'c-btns' },
      h('button', { class: 'btn small primary', onclick: () => answer(c, 'yes') }, t('yes_me')),
      h('button', { class: 'btn small', onclick: () => answer(c, 'no') }, t('not_me'))))));
  async function answer(c, a) {
    try { await api(`/api/candidates/${c.faceId}`, { method: 'POST', body: { answer: a } }); } catch (e) { toast(e.message); return; }
    candidates.splice(candidates.indexOf(c), 1);
    if (a === 'yes') sound.play('bell');
    if (!candidates.length) { s.close(); await refreshMe(); } else render();
  }
  render();
}

// ---------------- profile ----------------
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

function renderProfile() {
  const me = state.me;
  const name = h('input', { class: 'field', value: me.user.name, maxlength: 40 });
  const side = h('select', { class: 'field' }, ['groom', 'bride'].map((s) => h('option', { value: s, selected: s === me.user.side }, t(s + '_side'))));
  const save = h('button', { class: 'btn small', onclick: async () => {
    try { await api('/api/me', { method: 'PATCH', body: { name: name.value, side: side.value } }); toast('✓'); await refreshMeQuiet(); } catch (e) { toast(e.message); }
  } }, '✓');
  const fam = h('div', { class: 'fam-list' }, me.family.map((f) => h('div', { class: 'fam' }, h('span', { class: 'p-dot' }, (f.label || 'F')[0]), h('span', {}, f.label, f.status === 'pending' ? ' · …' : ''),
    h('button', { class: 'link-btn', onclick: async () => { if (!confirm(t('remove') + '?')) return; await api(`/api/family/${f.id}`, { method: 'DELETE' }); await refreshMeQuiet(); renderProfile(); } }, t('remove')))));
  const canAdd = me.family.length < me.familyMax;
  const famName = h('input', { class: 'field', placeholder: t('family_name'), maxlength: 40 });
  fill(content, 
    h('div', { class: 'hello' }, h('h2', { class: 'big-title' }, t('profile')), h('p', { class: 'muted' }, `+91 ••••• •${me.user.phoneLast4}`)),
    h('div', { class: 'card' }, h('label', {}, t('your_name'), h('div', { class: 'inline' }, name, save)), h('label', {}, t('i_am_with'), side)),
    me.familyMax > 0 ? h('div', { class: 'card' }, h('h3', {}, t('family')), h('p', { class: 'muted small' }, t('family_body')), fam,
      canAdd ? h('div', { class: 'inline' }, famName, h('button', { class: 'btn small primary', onclick: () => {
        if (!famName.value.trim()) { famName.focus(); return; }
        renderFaceSetup('family', famName.value.trim(), async () => { await refreshMeQuiet(); renderProfile(); });
      } }, '+')) : null) : null,
    h('div', { class: 'card settings' },
      h('div', { class: 'row-between' }, h('span', {}, t('language')), h('button', { class: 'seg on', onclick: () => { setLang(getLang() === 'hi' ? 'en' : 'hi'); renderShell(); switchTab('profile'); } }, getLang() === 'hi' ? 'English' : 'हिन्दी')),
      h('div', { class: 'row-between' }, h('span', {}, t('sound')), h('input', { type: 'checkbox', class: 'switch', checked: sound.enabled(), onchange: (e) => sound.set(e.target.checked) })),
      h('div', { class: 'row-between' }, h('span', {}, t('wifi_only')), h('input', { type: 'checkbox', class: 'switch', checked: uploader.prefs.wifiOnly, onchange: (e) => { uploader.prefs.wifiOnly = e.target.checked; } })),
      installPrompt ? h('button', { class: 'btn wide', onclick: () => installPrompt.prompt() }, t('install')) : null),
    h('div', { class: 'card' }, h('h3', {}, t('privacy')), h('p', { class: 'muted small' }, t('privacy_text'))),
    me.access && me.access !== 'guest' ? h('div', { class: 'card access-card' }, h('p', { class: 'eyebrow' }, t('your_access')), h('p', {}, t('access_' + me.access))) : null,
    me.user.role === 'admin' ? h('a', { class: 'btn wide', href: '/admin.html' }, t('admin'))
      : me.canModerate ? h('a', { class: 'btn wide', href: '/admin.html' }, t('help_pick')) : null,
    h('button', { class: 'btn wide', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); await clearCaches(); location.reload(); } }, t('sign_out')),
    me.user.role !== 'admin' ? h('button', { class: 'link-btn danger', onclick: deleteAccount }, t('delete_account')) : null,
  );
}

async function refreshMeQuiet() { state.me = await api('/api/me'); }

function deleteAccount() {
  const also = h('input', { type: 'checkbox' });
  const s = sheet(h('div', {}, h('h2', {}, t('delete_account')), h('p', {}, t('delete_account_q')),
    h('label', { class: 'check' }, also, h('span', {}, t('also_uploads'))),
    h('button', { class: 'btn danger wide', onclick: async () => {
      await api('/api/me', { method: 'DELETE', body: { deleteUploads: also.checked } }); await clearCaches(); s.close(); location.reload();
    } }, t('delete'))));
}

async function clearCaches() {
  try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* */ }
  try { localStorage.removeItem('wa_seen'); } catch { /* */ }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
