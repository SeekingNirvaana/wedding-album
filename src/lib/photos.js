import { HttpError, json, readJson, now, cleanName, ID_RE, SECURITY_HEADERS } from './util.js';
import { getSettings, hit } from './store.js';
import { eventById } from '../config.js';
import { decodeEmb, addTemplates } from './faces.js';

const MAX_UPLOAD = 12 * 1024 * 1024;
const isJpeg = (u8) => u8.length > 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff;

function validEventSide(event, side) {
  const ev = eventById(event);
  if (!ev) throw new HttpError(400, 'Unknown event');
  if (!ev.sides.includes(side)) throw new HttpError(400, 'Side not valid for this event');
}

// ---------------- visibility (the single source of truth) ----------------
/** SQL fragment: photos the user may see. Params: userId twice. */
const VISIBLE = `(p.uploader_id = ?1 OR (p.highlight = 1 AND p.status = 'ready') OR EXISTS (SELECT 1 FROM access a WHERE a.user_id = ?1 AND a.photo_id = p.id))`;

export async function canSee(env, session, photoId) {
  const p = await env.DB.prepare('SELECT id, uploader_id, status, hidden, highlight FROM photos WHERE id = ?').bind(photoId).first();
  if (!p) return null;
  if (session.isAdmin) return p;
  if (p.hidden) return null;
  if (p.uploader_id === session.user.id) return p;
  if (p.status !== 'ready') return null;
  if (p.highlight) return p;
  const a = await env.DB.prepare('SELECT 1 FROM access WHERE user_id = ? AND photo_id = ?').bind(session.user.id, photoId).first();
  return a ? p : null;
}

function photoOut(r, session) {
  return {
    id: r.id, event: r.event, side: r.side, source: r.source, credit: r.credit || null,
    w: r.w, h: r.h, t: r.sort_ts, status: r.status, faces: r.face_count,
    highlight: !!r.highlight, hidden: !!r.hidden, mine: r.uploader_id === session.user.id,
    reason: r.reason || null, group: r.group_id || null,
  };
}

// ---------------- upload ----------------
export async function upload(request, env, session, ctx) {
  const u = session.user;
  const url = new URL(request.url);
  const settings = await getSettings(env);
  if (!session.isAdmin) {
    if (settings.uploads_open !== '1') throw new HttpError(403, 'Uploads are closed');
    if (!u.enrolled) throw new HttpError(403, 'Set up your face first, then you can upload', { code: 'enroll_first' });
    const d = await hit(env, `up:${u.id}:${new Date().toISOString().slice(0, 10)}`, Number(settings.upload_daily_cap) || 300, 86400);
    if (!d.ok) throw new HttpError(429, 'Daily upload limit reached. Thank you for all the photos!');
  }
  const len = Number(request.headers.get('content-length') || 0);
  if (!len || len > MAX_UPLOAD) throw new HttpError(413, 'Photo too large');
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_UPLOAD || !isJpeg(new Uint8Array(buf, 0, 4))) throw new HttpError(415, 'Only JPEG photos');

  const event = url.searchParams.get('event') || 'other';
  const side = url.searchParams.get('side') || 'joint';
  validEventSide(event, side);
  const tk = Number(url.searchParams.get('takenAt'));
  const takenAt = Number.isFinite(tk) && tk > 1.6e12 && tk < now() + 86400_000 ? Math.round(tk) : null;
  const source = session.isAdmin && url.searchParams.get('source') === 'photographer' ? 'photographer' : 'guest';
  const credit = source === 'photographer' ? cleanName(url.searchParams.get('credit')) || 'Photographer' : u.name;

  const id = crypto.randomUUID();
  await env.PHOTOS.put(`orig/${id}.jpg`, buf, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO photos (id, uploader_id, source, credit, event, side, taken_at, sort_ts, created_at, bytes)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, u.id, source, credit, event, side, takenAt, takenAt || now(), now(), buf.byteLength),
    env.DB.prepare("INSERT INTO access (user_id, photo_id, reason, created_at) VALUES (?, ?, 'upload', ?)").bind(u.id, id, now()),
  ]);
  await env.JOBS.send({ type: 'process', photoId: id });
  return json({ id }, 201);
}

/** Replace a photo with a better-quality original (same ID, same links). Owner only, within 7 days. */
export async function upgrade(request, env, session, photoId) {
  const p = await env.DB.prepare('SELECT uploader_id, status, bytes, created_at FROM photos WHERE id = ?').bind(photoId).first();
  if (!p || p.uploader_id !== session.user.id) throw new HttpError(404, 'Not found');
  if (p.status !== 'ready' || now() - p.created_at > 7 * 86400_000) throw new HttpError(409, 'Cannot upgrade this photo now');
  const len = Number(request.headers.get('content-length') || 0);
  if (!len || len > MAX_UPLOAD) throw new HttpError(413, 'Photo too large');
  const buf = await request.arrayBuffer();
  if (!isJpeg(new Uint8Array(buf, 0, 4))) throw new HttpError(415, 'Only JPEG photos');
  if (buf.byteLength <= (p.bytes || 0) * 1.15) return json({ ok: true, skipped: true });
  await env.PHOTOS.put(`orig/${photoId}.jpg`, buf, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.JOBS.send({ type: 'process', photoId, upgrade: true });
  return json({ ok: true });
}

// ---------------- list ----------------
export async function list(request, env, session) {
  const url = new URL(request.url);
  const scope = url.searchParams.get('scope') || 'all';
  const where = ['?1 IS NOT NULL']; // ?1 is always the viewer's id; keeps numbered bindings consistent
  const args = [session.user.id];
  let from = 'photos p';
  let select = 'p.*';

  if (scope === 'mine') where.push('p.uploader_id = ?1');
  else if (scope === 'highlights') where.push("p.highlight = 1 AND p.status = 'ready'");
  else if (scope === 'me' || scope.startsWith('group:')) {
    const groupId = scope === 'me' ? null : scope.slice(6);
    if (groupId && !ID_RE.test(groupId)) throw new HttpError(400, 'Bad scope');
    from = 'access a JOIN photos p ON p.id = a.photo_id';
    select = 'p.*, a.reason, a.group_id';
    where.push("a.user_id = ?1 AND a.reason != 'upload'");
    if (groupId) { where.push(`a.group_id = ?${args.length + 1}`); args.push(groupId); }
    else where.push(`a.group_id IN (SELECT id FROM face_groups WHERE user_id = ?1 AND kind = 'self')`);
  } else if (scope === 'admin' && session.isAdmin) {
    // everything, for moderation
  } else {
    where.push(VISIBLE);
  }
  if (!session.isAdmin) where.push('p.hidden = 0');
  if (scope !== 'mine' && scope !== 'admin') where.push("p.status = 'ready'");

  const event = url.searchParams.get('event');
  if (event) { where.push(`p.event = ?${args.length + 1}`); args.push(event); }
  const side = url.searchParams.get('side');
  if (side) { where.push(`p.side = ?${args.length + 1}`); args.push(side); }
  const source = url.searchParams.get('source');
  if (source === 'guest' || source === 'photographer') { where.push(`p.source = ?${args.length + 1}`); args.push(source); }
  if (scope === 'admin') {
    const st = url.searchParams.get('status');
    if (['processing', 'ready', 'failed'].includes(st)) { where.push(`p.status = ?${args.length + 1}`); args.push(st); }
    if (url.searchParams.get('hidden') === '1') where.push('p.hidden = 1');
  }
  const cursor = url.searchParams.get('cursor');
  if (cursor) {
    const [ts, cid] = cursor.split('_');
    if (!Number.isFinite(Number(ts)) || !ID_RE.test(cid || '')) throw new HttpError(400, 'Bad cursor');
    where.push(`(p.sort_ts < ?${args.length + 1} OR (p.sort_ts = ?${args.length + 1} AND p.id < ?${args.length + 2}))`);
    args.push(Number(ts), cid);
  }
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 60));
  const sql = `SELECT ${select} FROM ${from} WHERE ${where.join(' AND ') || '1=1'} ORDER BY p.sort_ts DESC, p.id DESC LIMIT ${limit + 1}`;
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return json({ photos: page.map((r) => photoOut(r, session)), next: results.length > limit && last ? `${last.sort_ts}_${last.id}` : null });
}

export async function counts(request, env, session) {
  const scope = new URL(request.url).searchParams.get('scope') || 'all';
  let sql;
  if (scope === 'mine') sql = "SELECT event, side, COUNT(*) AS n FROM photos p WHERE p.uploader_id = ?1 AND p.hidden = 0 GROUP BY event, side";
  else if (scope === 'me') sql = `SELECT p.event, p.side, COUNT(*) AS n FROM access a JOIN photos p ON p.id = a.photo_id
            WHERE a.user_id = ?1 AND a.group_id IN (SELECT id FROM face_groups WHERE user_id = ?1 AND kind = 'self')
              AND p.hidden = 0 AND p.status = 'ready' GROUP BY p.event, p.side`;
  else if (scope === 'highlights') sql = "SELECT event, side, COUNT(*) AS n FROM photos p WHERE p.highlight = 1 AND p.hidden = 0 AND p.status = 'ready' AND ?1 IS NOT NULL GROUP BY event, side";
  else sql = `SELECT event, side, COUNT(*) AS n FROM photos p WHERE ${VISIBLE} AND p.hidden = 0 AND p.status = 'ready' GROUP BY event, side`;
  const { results } = await env.DB.prepare(sql).bind(session.user.id).all();
  return json({ counts: results });
}

export async function remove(env, session, photoId) {
  const p = await env.DB.prepare('SELECT uploader_id FROM photos WHERE id = ?').bind(photoId).first();
  if (!p) throw new HttpError(404, 'Not found');
  if (!session.isAdmin && p.uploader_id !== session.user.id) throw new HttpError(403, 'Not yours');
  await deletePhoto(env, photoId);
  return json({ ok: true });
}

export async function deletePhoto(env, photoId) {
  const { results } = await env.DB.prepare('SELECT id FROM faces WHERE photo_id = ?').bind(photoId).all();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM engage WHERE photo_id = ?').bind(photoId),
    env.DB.prepare('DELETE FROM candidates WHERE photo_id = ?').bind(photoId),
    env.DB.prepare('DELETE FROM access WHERE photo_id = ?').bind(photoId),
    env.DB.prepare('DELETE FROM faces WHERE photo_id = ?').bind(photoId),
    env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(photoId),
  ]);
  const keys = ['orig', 'full', 'view', 'thumb'].map((k) => `${k}/${photoId}.jpg`).concat(results.map((f) => `crop/${f.id}.jpg`));
  for (let i = 0; i < keys.length; i += 900) await env.PHOTOS.delete(keys.slice(i, i + 900));
}

// ---------------- "Is this you?" ----------------
export async function listCandidates(env, session) {
  const { results } = await env.DB.prepare(
    `SELECT c.face_id, c.group_id, c.score, g.label, g.kind FROM candidates c
       JOIN photos p ON p.id = c.photo_id JOIN face_groups g ON g.id = c.group_id
      WHERE c.user_id = ? AND c.status = 'pending' AND p.hidden = 0 AND p.status = 'ready' AND g.status = 'active'
      ORDER BY c.score DESC LIMIT 60`).bind(session.user.id).all();
  return json({ candidates: results.map((r) => ({ faceId: r.face_id, who: r.kind === 'self' ? 'you' : r.label })) });
}

export async function answerCandidate(request, env, session, faceId) {
  const body = await readJson(request);
  const c = await env.DB.prepare(
    `SELECT c.*, f.quality, f.q, f.s FROM candidates c JOIN faces f ON f.id = c.face_id WHERE c.user_id = ? AND c.face_id = ? AND c.status = 'pending'`
  ).bind(session.user.id, faceId).first();
  if (!c) throw new HttpError(404, 'Not found');
  const yes = body.answer === 'yes';
  const stmts = [env.DB.prepare('UPDATE candidates SET status = ? WHERE user_id = ? AND face_id = ?').bind(yes ? 'yes' : 'no', session.user.id, faceId)];
  if (yes) {
    stmts.push(env.DB.prepare(`INSERT INTO access (user_id, photo_id, reason, group_id, score, created_at) VALUES (?, ?, 'confirmed', ?, ?, ?)
                               ON CONFLICT(user_id, photo_id, group_id) DO NOTHING`).bind(session.user.id, c.photo_id, c.group_id, c.score, now()));
  }
  await env.DB.batch(stmts);
  // A confirmed, good-quality face teaches the template the wedding-day look (capped, and only close calls)
  if (yes && c.quality >= 0.6 && c.score >= 0.36) {
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM templates WHERE group_id = ? AND source = 'confirmed'").bind(c.group_id).first();
    if (n < 6) {
      await addTemplates(env, c.group_id, [{ q: c.q, s: c.s }], 'confirmed');
      await env.JOBS.send({ type: 'scan', groupId: c.group_id, cursor: 0 });
    }
  }
  return json({ ok: true });
}

// ---------------- images ----------------
export async function serveImage(request, env, session, url) {
  const m = url.pathname.match(/^\/img\/(full|view|thumb|crop)\/([0-9a-f-]{36}|\d{1,12})\.jpg$/);
  if (!m) return new Response('Not found', { status: 404 });
  const [, size, id] = m;
  let key;
  if (size === 'crop') {
    if (!/^\d+$/.test(id)) return new Response('Not found', { status: 404 });
    if (!session.isAdmin) {
      const c = await env.DB.prepare('SELECT 1 FROM candidates WHERE user_id = ? AND face_id = ?').bind(session.user.id, Number(id)).first();
      if (!c) return new Response('Not found', { status: 404 });
    }
    key = `crop/${id}.jpg`;
  } else {
    if (!ID_RE.test(id)) return new Response('Not found', { status: 404 });
    const p = await canSee(env, session, id);
    if (!p) return new Response('Not found', { status: 404 });
    key = p.status === 'ready' ? `${size}/${id}.jpg` : `orig/${id}.jpg`;
  }
  const etag = `"${key}"`;
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
  const obj = await env.PHOTOS.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  const headers = new Headers({
    'content-type': 'image/jpeg',
    'cache-control': key.startsWith('orig/') ? 'private, no-store' : 'private, max-age=2592000, immutable',
    etag,
    ...SECURITY_HEADERS,
    'content-security-policy': "default-src 'none'; sandbox",
  });
  if (url.searchParams.get('dl') === '1') headers.set('content-disposition', `attachment; filename="anoop-sanghmitra-${id.slice(0, 8)}.jpg"`);
  return new Response(obj.body, { headers });
}

export { validEventSide, decodeEmb };

/** Records that a guest opened, downloaded or shared a photo (once per guest per kind). Feeds Highlights suggestions. */
export async function engage(request, env, session, photoId) {
  const body = await readJson(request, 200);
  const kind = ['view', 'download', 'share'].includes(body.kind) ? body.kind : null;
  if (!kind) throw new HttpError(400, 'Bad kind');
  if (!(await canSee(env, session, photoId))) throw new HttpError(404, 'Not found');
  await env.DB.prepare('INSERT OR IGNORE INTO engage (photo_id, user_id, kind, at) VALUES (?, ?, ?, ?)').bind(photoId, session.user.id, kind, now()).run();
  return json({ ok: true });
}
