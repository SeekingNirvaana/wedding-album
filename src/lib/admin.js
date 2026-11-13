import { HttpError, json, readJson, now, ID_RE } from './util.js';
import { getSettings, setSettings, audit, bumpTemplatesVersion, peek } from './store.js';
import { validEventSide, deletePhoto } from './photos.js';

const SETTING_RULES = {
  signup_cap: (v) => Number.isInteger(+v) && +v >= 10 && +v <= 1000,
  family_max: (v) => Number.isInteger(+v) && +v >= 0 && +v <= 10,
  family_approval: (v) => ['on', 'off'].includes(v),
  uploads_open: (v) => ['0', '1'].includes(String(v)),
  upload_daily_cap: (v) => Number.isInteger(+v) && +v >= 10 && +v <= 5000,
  sms_daily_budget: (v) => Number.isInteger(+v) && +v >= 0 && +v <= 20000,
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
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.name, u.side, u.role, u.status, u.enrolled, u.liveness_mode, u.phone_last4, u.created_at, u.last_seen,
              (SELECT COUNT(*) FROM photos p WHERE p.uploader_id = u.id) AS uploads,
              (SELECT COUNT(*) FROM access a WHERE a.user_id = u.id AND a.reason != 'upload') AS matched,
              (SELECT COUNT(*) FROM face_groups g WHERE g.user_id = u.id AND g.kind = 'family' AND g.status != 'revoked') AS family
         FROM users u ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.created_at DESC LIMIT 300`).bind(...args).all();
    return json({ users: results });
  }

  let m = path.match(/^\/users\/([0-9a-f-]{36})$/);
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
    await env.DB.prepare('UPDATE photos SET event = ?, side = ?, hidden = COALESCE(?, hidden), highlight = COALESCE(?, highlight) WHERE id = ?')
      .bind(event, side, hidden, highlight, m[1]).run();
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
    env.DB.prepare('DELETE FROM candidates WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM challenges WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
}

export { ID_RE, now };
