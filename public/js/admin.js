import { api, h, fill, toast, thumbUrl } from './core.js';
import * as uploader from './uploader.js';
import qrcode from '/vendor/qrcode.mjs';

const root = document.getElementById('admin');
let config = null;
const fmtDate = (t) => (t ? new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–');
const fmtBytes = (b) => (b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB');

async function boot() {
  config = await api('/api/config');
  uploader.setConfig(config);
  let me;
  try { me = await api('/api/me'); } catch { location.href = '/'; return; }
  if (me.user.role !== 'admin') {
    if (me.canModerate) return helperShell();
    fill(root, h('p', { class: 'pad center' }, 'Admins only.')); return;
  }
  if (!me.isAdmin) return unlock();
  shell();
}

function unlock() {
  const code = h('input', { class: 'field', type: 'password', autocomplete: 'current-password', placeholder: 'Admin passcode' });
  const err = h('p', { class: 'err' });
  fill(root, h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    try { await api('/api/admin/unlock', { method: 'POST', body: { code: code.value } }); shell(); } catch (e2) { err.textContent = e2.message; }
  } }, h('h2', {}, 'Admin'), h('p', { class: 'muted' }, 'Enter the admin passcode. It stays unlocked on this phone for 12 hours.'), code, err, h('button', { class: 'btn primary wide' }, 'Unlock')));
}

const TABS = ['Overview', 'People', 'Suggested', 'Photos', 'Family', 'Flags', 'Upload', 'Share', 'Log'];
let MOD = '/api/admin'; // helpers use /api/mod for the few things they may do
let body;
function shell() {
  body = h('div');
  const nav = h('div', { class: 'chips admin-tabs' }, TABS.map((t, i) => h('button', { class: 'chip' + (i ? '' : ' on'), onclick: (e) => {
    nav.querySelectorAll('.chip').forEach((c) => c.classList.remove('on')); e.currentTarget.classList.add('on'); show(t);
  } }, t)));
  fill(root, h('header', { class: 'top' }, h('div', {}, h('p', { class: 'dev-line small' }, '॥ शुभ विवाह ॥'), h('p', { class: 'top-names' }, 'Album admin')),
    h('a', { class: 'link-btn', href: '/' }, 'Album')), nav, body);
  show('Overview');
}

function show(tab) {
  ({ Overview, People, Suggested, Photos, Family, Flags, Upload, Share, Log })[tab]();
}

async function Overview() {
  const o = await api('/api/admin/overview');
  const s = o.settings;
  const stat = (label, val, sub) => h('div', { class: 'stat' }, h('b', {}, val ?? 0), h('span', {}, label), sub ? h('small', {}, sub) : null);
  const cap = Number(s.signup_cap);
  const field = (key, label, type = 'number', opts) => {
    const el = opts ? h('select', { class: 'field', 'data-k': key }, opts.map(([v, l]) => h('option', { value: v, selected: s[key] === v }, l)))
      : h('input', { class: 'field', type, 'data-k': key, value: s[key] });
    return h('label', {}, label, el);
  };
  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    const patch = {};
    form.querySelectorAll('[data-k]').forEach((el) => { if (el.value !== s[el.dataset.k]) patch[el.dataset.k] = el.value; });
    if (!Object.keys(patch).length) return;
    try { await api('/api/admin/settings', { method: 'PUT', body: patch }); toast('Saved'); Overview(); } catch (e2) { toast(e2.message); }
  } },
    h('h3', {}, 'Settings'),
    field('uploads_open', 'Uploads', null, [['1', 'Open'], ['0', 'Closed']]),
    field('signup_cap', 'Maximum guests (up to 1000)'),
    field('family_max', 'Family faces per guest'),
    field('family_approval', 'Approve family faces manually', null, [['off', 'No, automatic'], ['on', 'Yes, I approve each']]),
    field('upload_daily_cap', 'Uploads per guest per day'),
    field('sms_daily_budget', 'SMS codes per day (budget)'),
    field('login_daily_cap', 'Sign-ins per number per day (admins unlimited)'),
    field('match_confident', 'Match: show automatically above', 'text'),
    field('match_possible', 'Match: ask "is this you?" above', 'text'),
    field('retention_date', 'Delete all face data on (YYYY-MM-DD)', 'text'),
    h('button', { class: 'btn primary wide' }, 'Save settings'));
  fill(body,
    h('div', { class: 'stats' },
      stat('Guests set up', o.users.enrolled, `of ${cap}${o.users.enrolled >= cap * 0.8 ? ' · nearly full!' : ''}`),
      stat('Signing up', o.users.pending, 'not finished'),
      stat('Photos', o.photos.total, `${o.photos.photographer || 0} photographer · ${fmtBytes(o.photos.bytes || 0)}`),
      stat('Processing', o.photos.processing, o.photos.failed ? `${o.photos.failed} failed` : 'face scan queue'),
      stat('Faces found', o.faces),
      stat('Family faces', o.groups.family, o.groups.family_pending ? `${o.groups.family_pending} waiting approval` : ''),
      stat('SMS today', o.smsToday, `budget ${s.sms_daily_budget}`),
      stat('Open flags', o.openFlags)),
    form);
}

async function Photos() {
  const filters = { status: '', hidden: '' };
  const grid = h('div', { class: 'grid' });
  const more = h('button', { class: 'btn wide' }, 'Load more');
  let cursor = null;
  async function load(reset) {
    if (reset) { cursor = null; fill(grid); }
    const q = new URLSearchParams({ scope: 'admin', limit: '60' });
    if (filters.status) q.set('status', filters.status);
    if (filters.hidden) q.set('hidden', '1');
    if (cursor) q.set('cursor', cursor);
    const r = await api('/api/photos?' + q);
    grid.append(...r.photos.map(tile));
    cursor = r.next; more.hidden = !cursor;
  }
  function tile(p) {
    const el = h('button', { class: 'tile admin-tile' + (p.hidden ? ' is-hidden' : ''), onclick: () => edit(p, el) },
      h('img', { src: thumbUrl(p.id), loading: 'lazy', alt: '', onload: (e) => e.target.classList.add('in') }),
      p.highlight ? h('span', { class: 'badge-star' }) : null,
      p.status !== 'ready' ? h('span', { class: 'badge-status' }, p.status) : null);
    return el;
  }
  function edit(p, el) {
    const ev = h('select', { class: 'field' }, config.events.map((e) => h('option', { value: e.id, selected: e.id === p.event }, e.name)));
    const sd = h('select', { class: 'field' }, ['groom', 'bride', 'joint'].map((s) => h('option', { value: s, selected: s === p.side }, config.sides[s].label)));
    const wrap = h('div', { class: 'sheet-wrap open' });
    const close = () => wrap.remove();
    const act = async (fn) => { try { await fn(); toast('Done'); close(); load(true); } catch (e) { toast(e.message); } };
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    wrap.append(h('div', { class: 'sheet', style: { transform: 'none' } },
      h('img', { src: `/img/view/${p.id}.jpg`, class: 'admin-preview', alt: '' }),
      h('p', { class: 'muted small' }, `${p.source}${p.credit ? ' · ' + p.credit : ''} · ${p.faces} faces · ${fmtDate(p.t)}`),
      h('div', { class: 'inline' }, ev, sd, h('button', { class: 'btn small', onclick: () => act(() => api(`/api/admin/photos/${p.id}`, { method: 'PATCH', body: { event: ev.value, side: sd.value } })) }, 'Move')),
      h('div', { class: 'admin-actions' },
        h('button', { class: 'btn', onclick: () => act(() => api(`/api/admin/photos/${p.id}`, { method: 'PATCH', body: { highlight: !p.highlight } })) }, p.highlight ? 'Remove from Highlights' : 'Add to Highlights'),
        h('button', { class: 'btn', onclick: () => act(() => api(`/api/admin/photos/${p.id}`, { method: 'PATCH', body: { hidden: !p.hidden } })) }, p.hidden ? 'Unhide' : 'Hide from everyone'),
        p.status === 'failed' ? h('button', { class: 'btn', onclick: () => act(() => api(`/api/admin/photos/${p.id}/reprocess`, { method: 'POST' })) }, 'Retry') : null,
        h('a', { class: 'btn', href: `/img/full/${p.id}.jpg?dl=1` }, 'Download'),
        h('button', { class: 'btn danger', onclick: () => confirm('Delete permanently?') && act(() => api(`/api/admin/photos/${p.id}`, { method: 'DELETE' })) }, 'Delete'))));
    document.body.append(wrap);
  }
  const seg = (label, apply) => h('button', { class: 'seg', onclick: (e) => { e.currentTarget.parentElement.querySelectorAll('.seg').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); apply(); load(true); } }, label);
  more.onclick = () => load(false);
  fill(body, h('div', { class: 'side-toggle' },
    seg('All', () => { filters.status = ''; filters.hidden = ''; }), seg('Processing', () => { filters.status = 'processing'; filters.hidden = ''; }),
    seg('Failed', () => { filters.status = 'failed'; filters.hidden = ''; }), seg('Hidden', () => { filters.status = ''; filters.hidden = '1'; })), grid, more);
  load(true);
}

async function Family() {
  const { family } = await api('/api/admin/family');
  const act = async (g, action) => { try { await api(`/api/admin/family/${g.id}`, { method: 'POST', body: { action } }); toast('Done'); Family(); } catch (e) { toast(e.message); } };
  fill(body, h('div', { class: 'rows' }, family.length ? family.map((g) => h('div', { class: 'row' },
    h('div', {}, h('b', {}, g.label), ` · added by ${g.owner} (••${g.phone_last4})`, h('small', { class: 'muted' }, ` ${g.status} · ${fmtDate(g.created_at)}`)),
    h('div', { class: 'row-actions' }, g.status === 'pending' ? h('button', { class: 'link-btn', onclick: () => act(g, 'approve') }, 'Approve') : null,
      h('button', { class: 'link-btn danger', onclick: () => confirm('Revoke this family face?') && act(g, 'revoke') }, 'Revoke')))) : h('p', { class: 'muted pad' }, 'No family faces yet.')));
}

async function Flags() {
  const { flags } = await api('/api/admin/flags');
  const label = { face_already_enrolled: 'Tried to register a face that already belongs to someone', liveness_lock: 'Locked after repeated failed face checks', login_limit: 'Reached the daily sign-in limit (People → Reset today’s sign-in limit if genuine)' };
  fill(body, h('div', { class: 'rows' }, flags.length ? flags.map((f) => h('div', { class: 'row' },
    h('div', {}, h('b', {}, label[f.kind] || f.kind), h('small', { class: 'muted' }, ` · ${f.name || 'deleted user'} ••${f.phone_last4 || ''} · ${fmtDate(f.created_at)}`), f.detail ? h('pre', { class: 'small muted' }, f.detail) : null),
    h('button', { class: 'link-btn', onclick: async () => { await api(`/api/admin/flags/${f.id}`, { method: 'POST' }); Flags(); } }, 'Resolve'))) : h('p', { class: 'muted pad' }, 'Nothing to review.')));
}

function Upload() {
  const ev = h('select', { class: 'field' }, h('option', { value: 'auto' }, 'Auto (by photo time)'), config.events.map((e) => h('option', { value: e.id }, e.name)));
  const sd = h('select', { class: 'field' }, ['joint', 'groom', 'bride'].map((s) => h('option', { value: s }, `${config.sides[s].label} · ${config.sides[s].place}`)));
  const credit = h('input', { class: 'field', placeholder: 'Photographer name (credit)', value: 'Photographer' });
  const pick = h('input', { type: 'file', accept: 'image/jpeg,image/*', multiple: true });
  const status = h('p', { class: 'muted' });
  uploader.onChange((items) => {
    const q = items.filter((i) => i.status !== 'done').length;
    status.textContent = q ? `${q} waiting or sending… keep this page open.` : 'All sent. Faces are scanned on the server.';
  });
  pick.addEventListener('change', async () => {
    await uploader.add([...pick.files], { event: ev.value, side: sd.value, mySide: 'joint', source: 'photographer', credit: credit.value });
    pick.value = '';
  });
  fill(body, h('div', { class: 'card' }, h('h3', {}, "Photographer's photos"),
    h('p', { class: 'muted small' }, 'Pick many files at once (works from a phone too). Each is resized for the album and scanned for faces on the server, so guests find themselves automatically.'),
    h('label', {}, 'Event', ev), h('label', {}, 'Side', sd), h('label', {}, 'Credit', credit), pick, status));
}

function Share() {
  const code = location.origin + '/';
  const msg = `🌼 Anoop & Sanghmitra's wedding album is live!\n\nUpload the photos you take, and find every photo you're in with one quick selfie.\n\n${code}`;
  const qr = qrcode(0, 'M'); qr.addData(code); qr.make();
  const svgBox = h('div', { class: 'qr' });
  svgBox.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); // generated locally from our own URL
  fill(body, h('div', { class: 'card center' }, h('h3', {}, 'Invite guests'),
    h('a', { class: 'btn primary wide', href: 'https://wa.me/?text=' + encodeURIComponent(msg), target: '_blank', rel: 'noopener' }, 'Share on WhatsApp'),
    h('button', { class: 'btn wide', onclick: () => navigator.clipboard.writeText(msg).then(() => toast('Copied')) }, 'Copy message'),
    h('div', { class: 'print-card' }, h('p', { class: 'dev-line' }, '॥ शुभ विवाह ॥'), h('h2', {}, 'Anoop & Sanghmitra'), h('p', { class: 'eyebrow' }, 'The wedding album'), svgBox,
      h('p', { class: 'small' }, 'Scan · upload your photos · find yourself with one selfie'), h('p', { class: 'small muted' }, code.replace('https://', ''))),
    h('button', { class: 'btn wide', onclick: () => window.print() }, 'Print table card')));
}

async function Log() {
  const { audit } = await api('/api/admin/audit');
  fill(body, h('div', { class: 'rows' }, audit.map((a) => h('div', { class: 'row' }, h('div', {}, h('b', {}, a.action), ` · ${a.name || ''}`, h('small', { class: 'muted' }, ` ${fmtDate(a.created_at)} ${a.target ? '· ' + a.target.slice(0, 8) : ''}`))))));
}

boot();

// Suggested Highlights: ranked by sharpness, light, who is in it (the two of you, many guests) and what guests loved.
// Nothing goes live until you tap Add.
async function Suggested() {
  fill(body, h('p', { class: 'muted pad' }, 'Finding the best photos…'));
  let data;
  try { data = await api(MOD + '/suggestions'); } catch (e) { fill(body, h('p', { class: 'err pad' }, e.message)); return; }
  const evName = (id) => config.events.find((e) => e.id === id)?.name || id;
  const sideName = (s) => config.sides[s]?.label || s;
  const buckets = h('div', { class: 'sugg-buckets' }, data.highlightsByBucket.length
    ? data.highlightsByBucket.map((b) => h('span', { class: 'seg' }, `${evName(b.event)}${b.side !== 'joint' ? ' · ' + sideName(b.side) : ''}: ${b.n}`))
    : h('span', { class: 'muted small' }, 'No Highlights yet.'));
  const list = h('div', { class: 'sugg-list' });
  const card = (p) => {
    const el = h('div', { class: 'sugg' },
      h('img', { src: thumbUrl(p.id), alt: '', loading: 'lazy', onclick: () => window.open(`/img/view/${p.id}.jpg`, '_blank') }),
      h('div', { class: 'sugg-meta' },
        h('b', {}, `${evName(p.event)}${p.side !== 'joint' ? ' · ' + sideName(p.side) : ''}`),
        h('div', { class: 'sugg-tags' }, p.reasons.map((r) => h('span', {}, r))),
        h('div', { class: 'sugg-btns' },
          h('button', { class: 'btn small primary', onclick: () => decide(p, el, { highlight: true }, 'Added to Highlights') }, '★ Add'),
          h('button', { class: 'btn small', onclick: () => decide(p, el, { suggest_skip: true }, 'Skipped') }, 'Skip'),
          h('button', { class: 'btn small', onclick: () => decide(p, el, { hidden: true }, 'Hidden from everyone') }, 'Hide'))));
    return el;
  };
  async function decide(p, el, patch, msg) {
    try { await api(`${MOD}/photos/${p.id}`, { method: 'PATCH', body: patch }); } catch (e) { toast(e.message); return; }
    el.classList.add('gone'); setTimeout(() => el.remove(), 300); toast(msg);
  }
  fill(list, data.suggestions.length ? data.suggestions.map(card) : h('p', { class: 'muted pad' }, 'No suggestions yet. They appear as photos come in.'));
  fill(body,
    h('div', { class: 'card' }, h('h3', {}, 'Suggested for Highlights'),
      h('p', { class: 'muted small' }, 'Best first, spread across every event and both sides. Tap a photo to see it large. Add puts it in Highlights for everyone; Skip removes it from this list only; Hide removes it from the album.'),
      h('p', { class: 'small', style: { marginTop: '8px' } }, 'Highlights so far:'), buckets),
    list,
    h('button', { class: 'btn wide', onclick: Suggested }, 'Refresh suggestions'));
}

// Helpers: only the Suggested list (plus star/hide inside the album itself)
function helperShell() {
  MOD = '/api/mod';
  body = h('div');
  fill(root, h('header', { class: 'top' }, h('div', {}, h('p', { class: 'dev-line small' }, '॥ शुभ विवाह ॥'), h('p', { class: 'top-names' }, 'Help pick Highlights')),
    h('a', { class: 'link-btn', href: '/' }, 'Album')), body);
  Suggested();
}

// ---------------- People: family & friends, categories, closeness, access ----------------
const ACCESS_LABEL = { guest: 'Standard', family: 'Their side', inner: 'Everything', helper: 'Helper' };
const ACCESS_HELP = {
  guest: 'Their own uploads, photos they are in, and Highlights.',
  family: 'Also every photo from their side’s Mehendi and Haldi, plus Shaadi and Vidai.',
  inner: 'Every photo in the album.',
  helper: 'Every photo, and can add Highlights or hide photos. Cannot change settings or see numbers.',
};
const CLOSE_LABEL = { 1: 'Very close', 2: 'Close', 3: 'Known' };
const CATS = ['Family', 'Friends', 'Colleagues', 'Neighbours', 'Other'];
/** Suggested access from closeness (you can always change it) */
const suggestAccess = (closeness, category) => (closeness === 1 ? (category === 'Family' ? 'inner' : 'family') : closeness === 2 ? 'family' : 'guest');

function selectEl(options, value, attrs = {}) {
  return h('select', { class: 'field', ...attrs }, options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value ?? '') }, label)));
}

function personForm(p = {}, subs = []) {
  const f = {
    name: h('input', { class: 'field', placeholder: 'Name', value: p.name || '', maxlength: 40 }),
    phone: p.id ? null : h('input', { class: 'field', type: 'tel', inputmode: 'numeric', placeholder: 'Mobile number', maxlength: 14 }),
    side: selectEl([['groom', "Groom's side"], ['bride', "Bride's side"]], p.side || 'groom'),
    category: selectEl([['', 'Category…'], ...CATS.map((c) => [c, c])], p.category),
    subcategory: h('input', { class: 'field', placeholder: 'Sub-group, e.g. Maternal side, College', value: p.subcategory || '', list: 'subcats', maxlength: 40 }),
    relation: h('input', { class: 'field', placeholder: 'Relation, e.g. Mausi, Roommate', value: p.relation || '', maxlength: 40 }),
    closeness: selectEl([['', 'Closeness…'], [1, 'Very close'], [2, 'Close'], [3, 'Known']], p.closeness),
    access: selectEl(Object.entries(ACCESS_LABEL), p.access || 'guest'),
  };
  const help = h('p', { class: 'muted small' }, ACCESS_HELP[f.access.value]);
  f.access.onchange = () => { help.textContent = ACCESS_HELP[f.access.value]; f.access.dataset.touched = '1'; };
  const auto = () => { if (!f.access.dataset.touched && f.closeness.value) { f.access.value = suggestAccess(Number(f.closeness.value), f.category.value); help.textContent = ACCESS_HELP[f.access.value]; } };
  f.closeness.onchange = auto; f.category.onchange = auto;
  const el = h('div', { class: 'person-form' },
    h('datalist', { id: 'subcats' }, subs.map((x) => h('option', { value: x }))),
    f.name, f.phone,
    h('div', { class: 'two' }, f.side, f.closeness),
    h('div', { class: 'two' }, f.category, f.subcategory),
    f.relation,
    h('label', { class: 'small muted' }, 'Can see', f.access), help);
  const value = () => ({ name: f.name.value, phone: f.phone?.value, side: f.side.value, category: f.category.value || null,
    subcategory: f.subcategory.value, relation: f.relation.value, closeness: f.closeness.value ? Number(f.closeness.value) : null, access: f.access.value });
  return { el, value };
}

function openPanel(...kids) {
  const wrap = h('div', { class: 'sheet-wrap open' });
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.append(h('div', { class: 'sheet', style: { transform: 'none', opacity: 1 } }, ...kids));
  document.body.append(wrap);
  return close;
}

async function People() {
  const q = h('input', { class: 'field', placeholder: 'Search name or last 4 digits' });
  const list = h('div', { class: 'people-list' });
  let filter = '', cat = '', subs = [];
  async function load() {
    const p = new URLSearchParams({ q: q.value }); if (filter) p.set('filter', filter); if (cat) p.set('category', cat);
    const r = await api('/api/admin/users?' + p);
    subs = r.subcategories;
    // group: category → sub-group
    const groups = new Map();
    for (const u of r.users) {
      const key = u.listed ? `${u.category || 'Not grouped'}${u.subcategory ? ' · ' + u.subcategory : ''}` : 'Joined by link';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(u);
    }
    fill(list, groups.size ? [...groups].map(([key, us]) => h('section', { class: 'pgroup' },
      h('h4', {}, key, h('small', {}, ` ${us.length}`)),
      us.map(row))) : h('p', { class: 'muted pad' }, 'Nobody here yet.'));
  }
  const row = (u) => h('button', { class: 'prow', onclick: () => edit(u) },
    h('span', { class: 'pav c' + (u.closeness || 0) }, (u.name || '?')[0]),
    h('span', { class: 'pmain' }, h('b', {}, u.name), h('small', {}, [u.relation, u.side === 'bride' ? "Bride's side" : "Groom's side", '••' + u.phone_last4,
      u.login_count ? `${u.login_count} sign-in${u.login_count === 1 ? '' : 's'}${u.logins_today ? ` (${u.logins_today} today)` : ''}` : null].filter(Boolean).join(' · '))),
    h('span', { class: 'ptags' },
      u.closeness ? h('i', { class: 'tag c' + u.closeness }, CLOSE_LABEL[u.closeness]) : null,
      u.role === 'admin' ? h('i', { class: 'tag acc' }, 'Admin') : u.access !== 'guest' ? h('i', { class: 'tag acc' }, ACCESS_LABEL[u.access]) : null,
      h('i', { class: 'tag ' + (u.signed_in ? 'ok' : 'wait') }, u.signed_in ? (u.enrolled ? 'Face ✓' : 'No face yet') : (u.enrolled ? 'Face ✓ · not joined' : 'Not joined'))));

  function edit(u) {
    const form = personForm(u, subs);
    const act = async (fn, msg) => { try { await fn(); toast(msg || 'Saved'); close(); load(); } catch (e) { toast(e.message); } };
    const post = (action) => api(`/api/admin/users/${u.id}`, { method: 'POST', body: { action } });
    const close = openPanel(h('h2', {}, u.name),
      h('p', { class: 'muted small' }, `••••${u.phone_last4} · ${u.uploads} uploads · ${u.matched} photos found · ${u.family} family faces${u.status === 'banned' ? ' · BANNED' : ''}`),
      h('p', { class: 'muted small' }, `Signed in ${u.login_count || 0} time${u.login_count === 1 ? '' : 's'} in total, ${u.logins_today || 0} today${u.last_login_at ? ` · last ${fmtDate(u.last_login_at)}` : ''}`),
      form.el,
      h('button', { class: 'btn primary wide', onclick: () => act(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: form.value() })) }, 'Save'),
      h('div', { class: 'admin-actions' },
        h('button', { class: 'btn', onclick: () => { close(); faceFromPhoto(u); } }, u.enrolled ? 'Add a family face from a photo' : 'Set their face from a photo'),
        u.role === 'admin' ? null : h('button', { class: 'btn', onclick: () => confirm(`Reset ${u.name}'s face?`) && act(() => post('reset_face'), 'Face reset') }, 'Reset face'),
        u.role === 'admin' ? null : h('button', { class: 'btn', onclick: () => act(() => post('unlock'), 'Unlocked') }, 'Unlock face setup'),
        u.role === 'admin' || !u.logins_today ? null : h('button', { class: 'btn', onclick: () => act(() => post('reset_login'), 'They can sign in again today') }, 'Reset today’s sign-in limit'),
        u.role === 'admin' ? null : h('button', { class: 'btn', onclick: () => act(() => post(u.status === 'banned' ? 'unban' : 'ban')) }, u.status === 'banned' ? 'Unban' : 'Ban'),
        u.listed && u.role !== 'admin' ? h('button', { class: 'btn', onclick: () => confirm(`Remove ${u.name} from your list? If they already joined, they stay as a normal guest.`) && act(() => post('unlist'), 'Removed from list') }, 'Remove from list') : null,
        u.role === 'admin' ? null : h('button', { class: 'btn danger', onclick: () => confirm(`Delete ${u.name}, their face and their uploads?`) && act(() => post('delete'), 'Deleted') }, 'Delete account')));
  }

  function addOne() {
    const form = personForm({}, subs);
    const err = h('p', { class: 'err' });
    const close = openPanel(h('h2', {}, 'Add a person'), form.el, err,
      h('button', { class: 'btn primary wide', onclick: async () => {
        const v = form.value();
        try {
          const r = await api('/api/admin/people', { method: 'POST', body: { people: [v] } });
          if (r.invalid.length) { err.textContent = 'Check the mobile number'; return; }
          toast(r.added.length ? `Added ${v.name}` : `Updated ${v.name}`); close(); load();
        } catch (e) { err.textContent = e.message; }
      } }, 'Add'));
  }

  async function fromContacts() {
    try {
      const picked = await navigator.contacts.select(['name', 'tel'], { multiple: true });
      const rows = picked.map((c) => ({ name: (c.name || [])[0] || '', phone: (c.tel || [])[0] || '' })).filter((r) => r.phone);
      if (rows.length) bulk(rows);
    } catch { /* cancelled */ }
  }

  function bulk(prefill = []) {
    const shared = personForm({}, subs);
    shared.el.querySelector('input[placeholder="Name"]').remove();
    shared.el.querySelector('input[type=tel]')?.remove();
    const ta = h('textarea', { class: 'field', rows: 8, placeholder: 'One person per line:\nName, mobile\nName, mobile, relation' },
      prefill.map((r) => `${r.name}, ${r.phone}`).join('\n'));
    const err = h('p', { class: 'err' });
    const close = openPanel(h('h2', {}, prefill.length ? `Add ${prefill.length} contacts` : 'Paste a list'),
      ta, h('p', { class: 'muted small' }, 'These settings apply to everyone in the list. You can change anyone later.'), shared.el, err,
      h('button', { class: 'btn primary wide', onclick: async () => {
        const common = shared.value();
        const people = ta.value.split('\n').map((l) => l.split(/[,\t;]/).map((x) => x.trim())).filter((p) => p.length >= 2 && p[1])
          .map(([name, phone, relation]) => ({ ...common, name, phone, relation: relation || common.relation }));
        if (!people.length) { err.textContent = 'Add at least one line: Name, mobile'; return; }
        try {
          const r = await api('/api/admin/people', { method: 'POST', body: { people } });
          toast(`Added ${r.added.length}, updated ${r.updated.length}`);
          if (r.invalid.length) { err.textContent = `Could not read these numbers: ${r.invalid.join(', ')}`; load(); return; }
          close(); load();
        } catch (e) { err.textContent = e.message; }
      } }, 'Add everyone'));
  }

  q.addEventListener('input', () => { clearTimeout(q.t); q.t = setTimeout(load, 300); });
  const seg = (label, f) => h('button', { class: 'seg' + (f === filter ? ' on' : ''), onclick: (e) => { filter = f; e.currentTarget.parentElement.querySelectorAll('.seg').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); load(); } }, label);
  const catSel = selectEl([['', 'All categories'], ...CATS.map((c) => [c, c])], '', { onchange: (e) => { cat = e.target.value; load(); } });
  fill(body,
    h('div', { class: 'card' },
      h('h3', {}, 'Family & friends'),
      h('p', { class: 'muted small' }, 'Add people before the wedding. When they sign in with that number, they get what you set here. Numbers are stored scrambled; only the last 4 digits are kept.'),
      h('div', { class: 'admin-actions' },
        h('button', { class: 'btn primary', onclick: addOne }, '+ Add a person'),
        'contacts' in navigator && 'select' in navigator.contacts ? h('button', { class: 'btn', onclick: fromContacts }, 'Pick from contacts') : null,
        h('button', { class: 'btn', onclick: () => bulk() }, 'Paste a list'))),
    h('div', { class: 'card' }, q, catSel,
      h('div', { class: 'side-toggle wrap' }, seg('Everyone', ''), seg('My list', 'listed'), seg('Everything', 'inner'), seg('Their side', 'family'), seg('Helpers', 'helper'),
        seg('Not joined', 'not_signed_in'), seg('Frequent sign-ins', 'frequent'), seg('No face', 'no_face'), seg('Banned', 'banned'))),
    list);
  load();
}

// Face from a photo: pick the person in a group photo, attach as their own face or as a family face
async function faceFromPhoto(u) {
  const input = h('input', { type: 'file', accept: 'image/jpeg', class: 'visually-hidden' });
  const label = h('input', { class: 'field', placeholder: 'Name of this family member, e.g. Dadi', maxlength: 40 });
  const asSel = selectEl(u.enrolled ? [['family', `A family member, shown in ${u.name}'s album`]] : [['self', `${u.name} themself`], ['family', `A family member, shown in ${u.name}'s album`]], u.enrolled ? 'family' : 'self');
  const faces = h('div', { class: 'face-picks' });
  const err = h('p', { class: 'err' });
  const syncLabel = () => { label.hidden = asSel.value === 'self'; };
  asSel.onchange = syncLabel; syncLabel();
  let preview = null, chosen = null;
  input.onchange = async () => {
    const file = input.files[0]; if (!file) return;
    err.textContent = ''; fill(faces, h('p', { class: 'muted small' }, 'Finding faces…'));
    try {
      const res = await fetch('/api/admin/faces/preview', { method: 'POST', body: file, headers: { 'content-type': 'image/jpeg' }, credentials: 'same-origin' });
      const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Failed');
      preview = d.previewId; chosen = d.faces.length === 1 ? 0 : null;
      fill(faces, d.faces.map((f) => h('button', { class: 'face-pick' + (f.i === chosen ? ' on' : ''), onclick: (e) => { chosen = f.i; faces.querySelectorAll('.face-pick').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } },
        h('img', { src: 'data:image/jpeg;base64,' + f.crop, alt: '' }), f.quality < 0.25 ? h('small', {}, 'too blurry') : null)));
    } catch (e) { fill(faces); err.textContent = e.message; }
  };
  const close = openPanel(h('h2', {}, 'Face from a photo'),
    h('p', { class: 'muted small' }, 'For people without a smartphone, or to set someone up before the wedding. Use a clear, recent photo where the face is large and facing the camera.'),
    h('label', { class: 'small muted' }, 'This face is', asSel), label,
    h('button', { class: 'btn wide', onclick: () => input.click() }, 'Choose photo'), input, faces, err,
    h('button', { class: 'btn primary wide', onclick: async () => {
      if (!preview) { err.textContent = 'Choose a photo first'; return; }
      if (chosen === null) { err.textContent = 'Tap the right face'; return; }
      try {
        await api('/api/admin/faces', { method: 'POST', body: { previewId: preview, index: chosen, userId: u.id, as: asSel.value, label: label.value } });
        toast('Face added. Their photos will appear within a few minutes.'); close(); show('People');
      } catch (e) { err.textContent = e.message; }
    } }, 'Save face'));
}
