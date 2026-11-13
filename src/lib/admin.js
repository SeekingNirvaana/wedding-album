import { HttpError, json, readJson, now, ID_RE, cleanName } from './util.js';
import { getSettings, setSettings, audit, bumpTemplatesVersion, peek } from './store.js';
import { validEventSide, deletePhoto } from './photos.js';
import { phoneHmac, ACCESS } from './auth.js';
import { normalizeIndianMobile } from './otp.js';
import { callFace, activeGroups, decodeEmb, groupScore, addTemplates } from './faces.js';

const SETTING_RULES = {
  signup_cap: (v) => Number.isInteger(+v) && +v >= 10 && +v <= 1000,
  family_max: (v) => Number.isInteger(+v) && +v >= 0 && +v <= 10,
  family_approval: (v) => ['on', 'off'].includes(v),
  uploads_open: (v) => ['0', '1'].includes(String(v)),
  upload_daily_cap: (v) => Number.isInteger(+v) && +v >= 10 && +v <= 5000,
  sms_daily_budget: (v) => Number.isInteger(+v) && +v >= 0 && +v <= 20000,
  login_daily_cap: (v) => Number.isInteger(+v) && +v >= 1 && +v <= 100,
  match_confident: (v) => +v >= 0.35 && +v <= 0.7,
  match_possible: (v) => +v >= 0.25 && +v <= 0.6,
  retention_date: (v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v),
};

export async function handleAdmin(request, env, session, url, ctx) {
  const path = url.pathname.slice('/api/admin'.length);
  const method = request.method;
  const admin = session.user.id;

  if (path === '/overview' && method === 'GET') {
    const day = new Date().toISOString().slice(0, 10);
    const [users, photos, faces, groups, flags, sms] = await Promise.all([
      env.DB.prepare("SELECT SUM(enrolled = 1 AND status = 'active') AS enrolled, SUM(enrolled = 0) AS pending, SUM(status = 'banned') AS banned FROM users").first(),
      env.DB.prepare("SELECT COUNT(*) AS total, SUM(status = 'processing') AS processing, SUM(status = 'failed') AS failed, SUM(source = 'photographer') AS photographer, SUM(hidden) AS hidden, SUM(highlight) AS highlights, COALESCE(SUM(bytes), 0) AS bytes FROM photos").first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM faces').first(),
      env.DB.prepare("SELECT SUM(kind = 'family' AND status = 'active') AS family, SUM(kind = 'family' AND status = 'pending') AS family_pending FROM face_groups").first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM flags WHERE resolved = 0').first(),
      peek(env, `sms:day:${day}`, 86400),
    ]);
    return json({ users, photos, faces: faces.n, groups, openFlags: flags.n, smsToday: sms, settings: await getSettings(env, true) });
  }

  if (path === '/settings' && method === 'PUT') {
    const body = await readJson(request);
    const patch = {};
    for (const [k, v] of Object.entries(body)) {
      if (!SETTING_RULES[k] || !SETTING_RULES[k](String(v))) throw new HttpError(400, `Invalid value for ${k}`);
      patch[k] = String(v);
    }
    if (patch.match_possible && patch.match_confident && +patch.match_possible >= +patch.match_confident) throw new HttpError(400, 'Possible must be below confident');
    const settings = await setSettings(env, patch);
    if (patch.match_confident || patch.match_possible) await bumpTemplatesVersion(env);
    await audit(env, admin, 'settings', null, patch);
    return json({ settings });
  }

  if (path === '/users' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 40);
    const filter = url.searchParams.get('filter');
    const where = [];
    const args = [];
    if (q) { where.push('(u.name LIKE ? OR u.phone_last4 = ?)'); args.push(`%${q}%`, q); }
    if (filter === 'pending') where.push('u.enrolled = 0');
    if (filter === 'banned') where.push("u.status = 'banned'");
    if (filter === 'admins') where.push("u.role = 'admin'");
    if (filter === 'listed') where.push('u.listed = 1');
    const dayWin = Math.floor(now() / 86400_000) * 86400_000;
    if (filter === 'frequent') { where.push(`(u.login_count >= 8 OR EXISTS (SELECT 1 FROM rate r WHERE r.k = 'login:day:' || u.phone_hmac AND r.win = ${dayWin} AND r.n >= 3))`); }
    if (filter === 'not_signed_in') where.push('u.consent_at IS NULL');
    if (filter === 'no_face') where.push('u.enrolled = 0');
    if (ACCESS.includes(filter)) { where.push('u.access = ?'); args.push(filter); }
    const cat = url.searchParams.get('category');
    if (cat) { where.push('u.category = ?'); args.push(cat.slice(0, 30)); }
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.name, u.side, u.role, u.status, u.enrolled, u.liveness_mode, u.phone_last4, u.created_at, u.last_seen,
              u.access, u.listed, u.category, u.subcategory, u.relation, u.closeness, u.consent_at IS NOT NULL AS signed_in,
              u.login_count, u.last_login_at,
              COALESCE((SELECT r.n FROM rate r WHERE r.k = 'login:day:' || u.phone_hmac AND r.win = ${Math.floor(now() / 86400_000) * 86400_000}), 0) AS logins_today,
              (SELECT COUNT(*) FROM photos p WHERE p.uploader_id = u.id) AS uploads,
              (SELECT COUNT(*) FROM access a WHERE a.user_id = u.id AND a.reason != 'upload') AS matched,
              (SELECT COUNT(*) FROM face_groups g WHERE g.user_id = u.id AND g.kind = 'family' AND g.status != 'revoked') AS family
         FROM users u ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.listed DESC, u.closeness IS NULL, u.closeness, u.category, u.subcategory, u.name LIMIT 1000`).bind(...args).all();
    const subs = await env.DB.prepare('SELECT DISTINCT subcategory AS s FROM users WHERE subcategory IS NOT NULL ORDER BY s').all();
    return json({ users: results, subcategories: subs.results.map((r) => r.s) });
  }

  if (path === '/people' && method === 'POST') return addPeople(request, env, admin);
  if (path === '/faces/preview' && method === 'POST') return facePreview(request, env);
  if (path === '/faces' && method === 'POST') return faceFromPhoto(request, env, admin);

  let m = path.match(/^\/users\/([0-9a-f-]{36})$/);
  if (m && method === 'PATCH') {
    const body = await readJson(request);
    const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(m[1]).first();
    if (!u) throw new HttpError(404, 'Not found');
    const f = personFields(body, u);
    await env.DB.prepare('UPDATE users SET name = ?, side = ?, access = ?, category = ?, subcategory = ?, relation = ?, closeness = ?, listed = 1 WHERE id = ?')
      .bind(f.name, f.side, f.access, f.category, f.subcategory, f.relation, f.closeness, u.id).run();
    await audit(env, admin, 'person_update', u.id, { access: f.access, closeness: f.closeness, category: f.category });
    return json({ ok: true });
  }
  if (m && method === 'POST') {
    const id = m[1];
    if (id === admin) throw new HttpError(400, 'You cannot change your own account here');
    const { action } = await readJson(request);
    if (action === 'ban' || action === 'unban') {
      await env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(action === 'ban' ? 'banned' : 'active', id).run();
      if (action === 'ban') await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
    } else if (action === 'reset_face') {
      await resetFaces(env, id, 'self');
      await env.DB.prepare('UPDATE users SET enrolled = 0, liveness_mode = NULL, enroll_fails = 0, enroll_locked_until = 0 WHERE id = ?').bind(id).run();
    } else if (action === 'unlock') {
      await env.DB.prepare('UPDATE users SET enroll_fails = 0, enroll_locked_until = 0 WHERE id = ?').bind(id).run();
    } else if (action === 'delete') {
      await deleteUser(env, id, true);
    } else if (action === 'reset_login') {
      const u = await env.DB.prepare('SELECT phone_hmac FROM users WHERE id = ?').bind(id).first();
      if (u) await env.DB.prepare('DELETE FROM rate WHERE k IN (?, ?)').bind('login:day:' + u.phone_hmac, 'otp:phd:' + u.phone_hmac).run();
    } else if (action === 'unlist') {
      const u = await env.DB.prepare('SELECT consent_at, enrolled FROM users WHERE id = ?').bind(id).first();
      // Never signed in and nothing attached: remove entirely. Otherwise keep the account as a normal guest.
      if (u && !u.consent_at && !u.enrolled) await deleteUser(env, id, true);
      else await env.DB.prepare("UPDATE users SET listed = 0, access = 'guest' WHERE id = ?").bind(id).run();
    } else throw new HttpError(400, 'Unknown action');
    await audit(env, admin, `user_${action}`, id);
    return json({ ok: true });
  }

  if (path === '/family' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT g.id, g.label, g.status, g.created_at, g.liveness_mode, u.name AS owner, u.phone_last4, u.id AS owner_id
         FROM face_groups g JOIN users u ON u.id = g.user_id WHERE g.kind = 'family' AND g.status != 'revoked' ORDER BY g.status DESC, g.created_at DESC`).all();
    return json({ family: results });
  }

  m = path.match(/^\/family\/([0-9a-f-]{36})$/);
  if (m && method === 'POST') {
    const { action } = await readJson(request);
    const g = await env.DB.prepare("SELECT * FROM face_groups WHERE id = ? AND kind = 'family'").bind(m[1]).first();
    if (!g) throw new HttpError(404, 'Not found');
    if (action === 'approve') {
      await env.DB.prepare("UPDATE face_groups SET status = 'active' WHERE id = ?").bind(g.id).run();
      await bumpTemplatesVersion(env);
      await env.JOBS.send({ type: 'scan', groupId: g.id, cursor: 0 });
    } else if (action === 'revoke') {
      await env.DB.batch([
        env.DB.prepare("UPDATE face_groups SET status = 'revoked' WHERE id = ?").bind(g.id),
        env.DB.prepare("DELETE FROM access WHERE group_id = ? AND reason != 'upload'").bind(g.id),
        env.DB.prepare('DELETE FROM candidates WHERE group_id = ?').bind(g.id),
        env.DB.prepare('DELETE FROM templates WHERE group_id = ?').bind(g.id),
      ]);
      await bumpTemplatesVersion(env);
    } else throw new HttpError(400, 'Unknown action');
    await audit(env, admin, `family_${action}`, g.id, { owner: g.user_id });
    return json({ ok: true });
  }

  if (path === '/suggestions' && method === 'GET') return json(await suggestions(env));

  m = path.match(/^\/photos\/([0-9a-f-]{36})$/);
  if (m && method === 'PATCH') {
    const body = await readJson(request);
    const p = await env.DB.prepare('SELECT event, side FROM photos WHERE id = ?').bind(m[1]).first();
    if (!p) throw new HttpError(404, 'Not found');
    const event = body.event ?? p.event;
    const side = body.side ?? p.side;
    validEventSide(event, side);
    const hidden = body.hidden === undefined ? null : body.hidden ? 1 : 0;
    const highlight = body.highlight === undefined ? null : body.highlight ? 1 : 0;
    const skip = body.suggest_skip === undefined ? null : body.suggest_skip ? 1 : 0;
    await env.DB.prepare('UPDATE photos SET event = ?, side = ?, hidden = COALESCE(?, hidden), highlight = COALESCE(?, highlight), suggest_skip = COALESCE(?, suggest_skip) WHERE id = ?')
      .bind(event, side, hidden, highlight, skip, m[1]).run();
    await audit(env, admin, 'photo_update', m[1], body);
    return json({ ok: true });
  }
  if (m && method === 'DELETE') {
    await deletePhoto(env, m[1]);
    await audit(env, admin, 'photo_delete', m[1]);
    return json({ ok: true });
  }
  m = path.match(/^\/photos\/([0-9a-f-]{36})\/reprocess$/);
  if (m && method === 'POST') {
    const p = await env.DB.prepare('SELECT status FROM photos WHERE id = ?').bind(m[1]).first();
    if (!p) throw new HttpError(404, 'Not found');
    if (p.status !== 'failed') throw new HttpError(400, 'Only failed photos can be retried');
    await env.DB.prepare("UPDATE photos SET status = 'processing' WHERE id = ?").bind(m[1]).run();
    await env.JOBS.send({ type: 'process', photoId: m[1] });
    return json({ ok: true });
  }

  if (path === '/flags' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT f.*, u.name, u.phone_last4 FROM flags f LEFT JOIN users u ON u.id = f.user_id WHERE f.resolved = 0 ORDER BY f.created_at DESC LIMIT 200`).all();
    return json({ flags: results });
  }
  m = path.match(/^\/flags\/(\d+)$/);
  if (m && method === 'POST') {
    await env.DB.prepare('UPDATE flags SET resolved = 1 WHERE id = ?').bind(Number(m[1])).run();
    return json({ ok: true });
  }

  if (path === '/audit' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT a.*, u.name FROM audit a LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.created_at DESC LIMIT 200').all();
    return json({ audit: results });
  }

  throw new HttpError(404, 'Not found');
}

export async function resetFaces(env, userId, kind) {
  const { results } = await env.DB.prepare(`SELECT id FROM face_groups WHERE user_id = ? ${kind ? 'AND kind = ?' : ''}`)
    .bind(...(kind ? [userId, kind] : [userId])).all();
  const stmts = [];
  for (const g of results) {
    stmts.push(env.DB.prepare("DELETE FROM access WHERE group_id = ? AND reason != 'upload'").bind(g.id));
    stmts.push(env.DB.prepare('DELETE FROM candidates WHERE group_id = ?').bind(g.id));
    stmts.push(env.DB.prepare('DELETE FROM templates WHERE group_id = ?').bind(g.id));
    stmts.push(env.DB.prepare('DELETE FROM face_groups WHERE id = ?').bind(g.id));
  }
  if (stmts.length) await env.DB.batch(stmts);
  await bumpTemplatesVersion(env);
}

export async function deleteUser(env, userId, deleteUploads) {
  await resetFaces(env, userId, null);
  if (deleteUploads) {
    const { results } = await env.DB.prepare('SELECT id FROM photos WHERE uploader_id = ?').bind(userId).all();
    for (const p of results) await deletePhoto(env, p.id);
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM access WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM engage WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM candidates WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM challenges WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
}

export { ID_RE, now };

// ---------------- Highlights suggestions ----------------
// Ranks photos that are not yet in Highlights. Nothing is published: the couple approves each one.
const W = { sharp: 0.24, exposure: 0.08, people: 0.2, couple: 0.26, loved: 0.22 };

export async function suggestions(env, limit = 40) {
  const [{ results: photos }, { results: couple }, { results: people }, { results: loved }, { results: hl }] = await Promise.all([
    env.DB.prepare(`SELECT id, event, side, face_count, sharp, exposure, source, credit, sort_ts FROM photos
                    WHERE status = 'ready' AND hidden = 0 AND highlight = 0 AND suggest_skip = 0 ORDER BY sort_ts DESC LIMIT 3000`).all(),
    // photos where the couple (admin accounts' own faces) were recognised
    env.DB.prepare(`SELECT a.photo_id, COUNT(DISTINCT a.user_id) AS n FROM access a
                    JOIN face_groups g ON g.id = a.group_id AND g.kind = 'self'
                    JOIN users u ON u.id = a.user_id AND u.role = 'admin'
                    WHERE a.reason IN ('match', 'confirmed') GROUP BY a.photo_id`).all(),
    // how many different guests were recognised in each photo
    env.DB.prepare(`SELECT photo_id, COUNT(DISTINCT user_id) AS n FROM access WHERE reason IN ('match', 'confirmed') GROUP BY photo_id`).all(),
    env.DB.prepare(`SELECT photo_id, SUM(kind = 'view') AS v, SUM(kind = 'download') AS d, SUM(kind = 'share') AS s FROM engage GROUP BY photo_id`).all(),
    env.DB.prepare(`SELECT event, side, COUNT(*) AS n FROM photos WHERE highlight = 1 AND hidden = 0 GROUP BY event, side`).all(),
  ]);
  const coupleBy = new Map(couple.map((r) => [r.photo_id, r.n]));
  const peopleBy = new Map(people.map((r) => [r.photo_id, r.n]));
  const lovedBy = new Map(loved.map((r) => [r.photo_id, r.v + 3 * r.d + 4 * r.s]));
  const maxLoved = Math.max(1, ...lovedBy.values());

  const scored = photos.map((p) => {
    const sharp = p.sharp ?? 0.5, exposure = p.exposure ?? 0.6;
    const nPeople = Math.max(peopleBy.get(p.id) || 0, Math.min(p.face_count, 12) * 0.6);
    const peopleN = Math.min(1, nPeople / 8);
    const coupleN = Math.min(1, (coupleBy.get(p.id) || 0) / 2);
    const lovedN = Math.log1p(lovedBy.get(p.id) || 0) / Math.log1p(maxLoved);
    let score = W.sharp * sharp + W.exposure * exposure + W.people * peopleN + W.couple * coupleN + W.loved * lovedN;
    if (sharp < 0.25) score *= 0.4;          // clearly blurry: keep near the bottom
    if (p.face_count === 0) score *= 0.75;   // decor and venue shots can be lovely, but people first
    const reasons = [];
    if (coupleN >= 1) reasons.push('Both of you'); else if (coupleN > 0) reasons.push('One of you');
    if (nPeople >= 5) reasons.push(`${Math.round(nPeople)} guests`);
    if (sharp >= 0.7) reasons.push('Sharp');
    if (lovedN >= 0.5 && (lovedBy.get(p.id) || 0) >= 3) reasons.push('Popular');
    if (p.source === 'photographer') reasons.push('Photographer');
    return { id: p.id, event: p.event, side: p.side, score: Math.round(score * 100), reasons, t: p.sort_ts };
  }).sort((a, b) => b.score - a.score);

  // Spread across events and sides: each pick lowers the priority of its bucket,
  // and buckets that already have many Highlights start lower.
  const have = new Map(hl.map((r) => [`${r.event}|${r.side}`, r.n]));
  const picked = new Map();
  const out = [];
  const pool = scored.slice(0, 400);
  while (out.length < limit && pool.length) {
    let best = 0, bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const key = `${pool[i].event}|${pool[i].side}`;
      const crowd = (picked.get(key) || 0) + (have.get(key) || 0) * 0.5;
      const val = pool[i].score - crowd * 6;
      if (val > bestVal) { bestVal = val; best = i; }
    }
    const [p] = pool.splice(best, 1);
    const key = `${p.event}|${p.side}`;
    picked.set(key, (picked.get(key) || 0) + 1);
    out.push(p);
  }
  return { suggestions: out, highlightsByBucket: hl };
}

// ---------------- People list ----------------
export const CATEGORIES = ['Family', 'Friends', 'Colleagues', 'Neighbours', 'Other'];

function personFields(b, cur = {}) {
  const pick = (v, ok, dflt) => (v === undefined ? dflt : ok(v) ? v : (() => { throw new HttpError(400, 'Invalid value'); })());
  const text = (v, d) => (v === undefined ? d : cleanName(String(v || '')).slice(0, 40) || null);
  const closeness = b.closeness === undefined ? cur.closeness ?? null : b.closeness === null || b.closeness === '' ? null : Number(b.closeness);
  if (closeness !== null && ![1, 2, 3].includes(closeness)) throw new HttpError(400, 'Closeness must be 1, 2 or 3');
  return {
    name: text(b.name, cur.name) || cur.name || 'Guest',
    side: pick(b.side, (v) => ['groom', 'bride'].includes(v), cur.side || 'groom'),
    access: pick(b.access, (v) => ACCESS.includes(v), cur.access || 'guest'),
    category: pick(b.category, (v) => v === null || v === '' || CATEGORIES.includes(v), cur.category ?? null) || null,
    subcategory: text(b.subcategory, cur.subcategory ?? null),
    relation: text(b.relation, cur.relation ?? null),
    closeness,
  };
}

/** Add one or many people. Existing accounts (same number) are updated instead of duplicated. */
async function addPeople(request, env, admin) {
  const body = await readJson(request, 256 * 1024);
  const rows = Array.isArray(body.people) ? body.people.slice(0, 500) : [];
  if (!rows.length) throw new HttpError(400, 'Nobody to add');
  const added = [], updated = [], invalid = [];
  const admins = new Set(String(env.ADMIN_PHONES || '').split(',').map((p) => normalizeIndianMobile(p)).filter(Boolean));
  for (const r of rows) {
    const ten = normalizeIndianMobile(r.phone);
    if (!ten) { invalid.push(r.name || r.phone || '?'); continue; }
    const ph = await phoneHmac(env, ten);
    const cur = await env.DB.prepare('SELECT * FROM users WHERE phone_hmac = ?').bind(ph).first();
    const f = personFields(r, cur || {});
    if (cur) {
      await env.DB.prepare('UPDATE users SET name = ?, side = ?, access = ?, category = ?, subcategory = ?, relation = ?, closeness = ?, listed = 1 WHERE id = ?')
        .bind(cur.consent_at ? cur.name : f.name, f.side, f.access, f.category, f.subcategory, f.relation, f.closeness, cur.id).run();
      updated.push(f.name);
    } else {
      await env.DB.prepare(`INSERT INTO users (id, phone_hmac, phone_last4, name, side, role, access, listed, category, subcategory, relation, closeness, added_by, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), ph, ten.slice(-4), f.name, f.side, admins.has(ten) ? 'admin' : 'guest', f.access, f.category, f.subcategory, f.relation, f.closeness, admin, now()).run();
      added.push(f.name);
    }
  }
  await audit(env, admin, 'people_add', null, { added: added.length, updated: updated.length, invalid: invalid.length });
  return json({ added, updated, invalid });
}

// ---------------- Faces from a photo (admins only; for people without smartphones, or to set someone up in advance) ----------------
async function facePreview(request, env) {
  const len = Number(request.headers.get('content-length') || 0);
  if (!len || len > 12 * 1024 * 1024) throw new HttpError(413, 'Photo too large');
  const buf = await request.arrayBuffer();
  const res = await callFace(env, '/process', { method: 'POST', body: buf, headers: { 'content-type': 'image/jpeg' } });
  if (!res.ok) throw new HttpError(res.status === 415 ? 415 : 502, res.status === 415 ? 'Please choose a JPEG photo' : 'Face check is busy, please try again');
  const out = await res.json();
  const faces = out.faces.filter((f) => f.crop).slice(0, 30);
  if (!faces.length) throw new HttpError(400, 'No faces found in this photo. Try a clearer, closer photo.');
  const previewId = crypto.randomUUID();
  await env.PHOTOS.put(`tmp/preview/${previewId}.json`, JSON.stringify({ at: now(), faces: faces.map((f) => ({ emb: f.emb, quality: f.quality })) }));
  return json({ previewId, faces: faces.map((f, i) => ({ i, crop: f.crop, quality: f.quality })) });
}

async function faceFromPhoto(request, env, admin) {
  const body = await readJson(request);
  if (!ID_RE.test(String(body.previewId || '')) || !ID_RE.test(String(body.userId || ''))) throw new HttpError(400, 'Bad request');
  const obj = await env.PHOTOS.get(`tmp/preview/${body.previewId}.json`);
  if (!obj) throw new HttpError(400, 'This preview expired. Choose the photo again.');
  const data = await obj.json();
  if (now() - data.at > 30 * 60_000) throw new HttpError(400, 'This preview expired. Choose the photo again.');
  const face = data.faces[Number(body.index)];
  if (!face) throw new HttpError(400, 'Pick a face');
  if (face.quality < 0.25) throw new HttpError(400, 'That face is too small or blurry. Use a closer, sharper photo.');
  const owner = await env.DB.prepare('SELECT id, name, enrolled FROM users WHERE id = ?').bind(body.userId).first();
  if (!owner) throw new HttpError(404, 'Person not found');
  const asSelf = body.as === 'self';
  if (asSelf && owner.enrolled) throw new HttpError(409, `${owner.name} already has a face set up. Reset it first if it is wrong.`);

  // One face, one person
  const emb = decodeEmb(face.emb.q, face.emb.s);
  for (const g of await activeGroups(env)) {
    if (groupScore(g, emb) >= 0.5) throw new HttpError(409, 'This face is already set up for someone in the album.');
  }
  const groupId = crypto.randomUUID();
  const label = asSelf ? null : cleanName(body.label) || 'Family';
  await env.DB.prepare("INSERT INTO face_groups (id, user_id, kind, label, status, liveness_mode, created_at) VALUES (?, ?, ?, ?, 'active', 'admin_photo', ?)")
    .bind(groupId, owner.id, asSelf ? 'self' : 'family', label, now()).run();
  await addTemplates(env, groupId, [face.emb]);
  if (asSelf) await env.DB.prepare("UPDATE users SET enrolled = 1, liveness_mode = 'admin_photo' WHERE id = ?").bind(owner.id).run();
  await env.PHOTOS.delete(`tmp/preview/${body.previewId}.json`);
  await env.JOBS.send({ type: 'scan', groupId, cursor: 0 });
  await audit(env, admin, 'face_from_photo', owner.id, { as: asSelf ? 'self' : 'family', label });
  return json({ ok: true, groupId });
}

// ---------------- Helpers (moderators): suggestions and Highlight/Hide only ----------------
export async function handleMod(request, env, session, url) {
  const path = url.pathname.slice('/api/mod'.length);
  if (path === '/suggestions' && request.method === 'GET') return json(await suggestions(env));
  const m = path.match(/^\/photos\/([0-9a-f-]{36})$/);
  if (m && request.method === 'PATCH') {
    const b = await readJson(request);
    const set = [], args = [];
    if (b.highlight !== undefined) { set.push('highlight = ?'); args.push(b.highlight ? 1 : 0); }
    if (b.hidden !== undefined) { set.push('hidden = ?'); args.push(b.hidden ? 1 : 0); }
    if (b.suggest_skip !== undefined) { set.push('suggest_skip = ?'); args.push(b.suggest_skip ? 1 : 0); }
    if (!set.length) throw new HttpError(400, 'Nothing to change');
    const r = await env.DB.prepare(`UPDATE photos SET ${set.join(', ')} WHERE id = ?`).bind(...args, m[1]).run();
    if (!r.meta.changes) throw new HttpError(404, 'Not found');
    await audit(env, session.user.id, 'mod_photo', m[1], b);
    return json({ ok: true });
  }
  throw new HttpError(404, 'Not found');
}
