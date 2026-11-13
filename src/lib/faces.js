import { getRandom } from '@cloudflare/containers';
import { HttpError, b64ToBytes, bytesToB64, now } from './util.js';
import { getSettings, bumpTemplatesVersion } from './store.js';

// ---------------- face service transport ----------------
export async function callFace(env, path, init) {
  if (env.ENVIRONMENT === 'development' && env.FACE_URL) {
    return fetch(env.FACE_URL + path, init);
  }
  const stub = await getRandom(env.FACE, Number(env.FACE_INSTANCES) || 3);
  return stub.fetch(new Request('http://face' + path, init));
}

// ---------------- int8 embeddings ----------------
export function decodeEmb(q, s) {
  const b = b64ToBytes(q);
  return { v: new Int8Array(b.buffer, b.byteOffset, b.length), s };
}

/** Cosine similarity of two quantised unit vectors. */
export function sim(a, b) {
  let acc = 0;
  const x = a.v, y = b.v;
  for (let i = 0; i < 512; i++) acc += x[i] * y[i];
  return acc * (a.s / 127) * (b.s / 127);
}

// ---------------- template cache (per isolate, invalidated by settings.templates_version) ----------------
let tcache = { version: null, groups: [] };

export async function activeGroups(env) {
  const settings = await getSettings(env);
  if (tcache.version === settings.templates_version) return tcache.groups;
  const { results } = await env.DB.prepare(
    `SELECT g.id AS gid, g.user_id, g.kind, g.liveness_mode, t.q, t.s
       FROM face_groups g JOIN templates t ON t.group_id = g.id
      WHERE g.status = 'active'`
  ).all();
  const map = new Map();
  for (const r of results) {
    if (!map.has(r.gid)) map.set(r.gid, { id: r.gid, userId: r.user_id, kind: r.kind, mode: r.liveness_mode, vecs: [] });
    map.get(r.gid).vecs.push(decodeEmb(r.q, r.s));
  }
  tcache = { version: settings.templates_version, groups: [...map.values()] };
  return tcache.groups;
}

export function groupScore(group, emb) {
  let best = -1;
  for (const v of group.vecs) {
    const s = sim(v, emb);
    if (s > best) best = s;
  }
  return best;
}

export function thresholds(settings, group, faceQuality) {
  let confident = Number(settings.match_confident) || 0.45;
  const possible = Number(settings.match_possible) || 0.32;
  if (faceQuality < 0.5) confident += 0.05;      // small, blurry or side-on faces need stronger evidence
  if (group.mode === 'stills') confident += 0.03; // weaker liveness at enrolment
  return { confident, possible };
}

/** Decide outcomes for one face against all groups. Returns list of {group, score, kind:'access'|'candidate'} */
export function decideFace(settings, groups, emb, quality) {
  const scored = [];
  for (const g of groups) {
    const s = groupScore(g, emb);
    if (s >= (Number(settings.match_possible) || 0.32)) scored.push({ group: g, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  const top = scored[0];
  const { confident } = thresholds(settings, top.group, quality);
  // A face belongs to at most one person: only the best group can get automatic access
  if (top.score >= confident) return [{ group: top.group, score: top.score, kind: 'access' }];
  // Borderline: ask, but only the best candidate, and only if it clearly beats the runner-up
  if (scored.length > 1 && top.score - scored[1].score < 0.04) return [];
  return [{ group: top.group, score: top.score, kind: 'candidate' }];
}

export function outcomeStatements(env, outcomes, faceId, photoId) {
  const t = now();
  return outcomes.map((o) => o.kind === 'access'
    ? env.DB.prepare(`INSERT INTO access (user_id, photo_id, reason, group_id, score, created_at) VALUES (?, ?, 'match', ?, ?, ?)
                      ON CONFLICT(user_id, photo_id, group_id) DO UPDATE SET score = MAX(score, excluded.score)`)
      .bind(o.group.userId, photoId, o.group.id, o.score, t)
    : env.DB.prepare(`INSERT OR IGNORE INTO candidates (user_id, face_id, photo_id, group_id, score, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(o.group.userId, faceId, photoId, o.group.id, o.score, t));
}

// ---------------- jobs ----------------

/** Process an uploaded photo: renditions, faces, matching. */
export async function processPhoto(env, photoId, upgrade = false) {
  const photo = await env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind(photoId).first();
  if (!photo || (photo.status === 'ready' && !upgrade)) return;
  const orig = await env.PHOTOS.get(`orig/${photoId}.jpg`);
  if (!orig) {
    await env.DB.prepare("UPDATE photos SET status = 'failed' WHERE id = ?").bind(photoId).run();
    return;
  }
  const res = await callFace(env, '/process', { method: 'POST', body: await orig.arrayBuffer(), headers: { 'content-type': 'image/jpeg' } });
  if (res.status === 415 || res.status === 413) {
    await env.DB.prepare("UPDATE photos SET status = 'failed' WHERE id = ?").bind(photoId).run();
    return;
  }
  if (!res.ok) throw new Error(`face service ${res.status}`);
  const out = await res.json();

  const put = (key, b64) => env.PHOTOS.put(key, b64ToBytes(b64), { httpMetadata: { contentType: 'image/jpeg' } });
  await Promise.all([put(`full/${photoId}.jpg`, out.full), put(`view/${photoId}.jpg`, out.view), put(`thumb/${photoId}.jpg`, out.thumb)]);

  // Face rows are rebuilt; pending "is this you?" questions for the old rows are dropped (matches are kept)
  const old = await env.DB.prepare('SELECT id FROM faces WHERE photo_id = ?').bind(photoId).all();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM candidates WHERE photo_id = ? AND status = 'pending'").bind(photoId),
    env.DB.prepare('DELETE FROM faces WHERE photo_id = ?').bind(photoId),
  ]);
  if (old.results.length) await env.PHOTOS.delete(old.results.map((f) => `crop/${f.id}.jpg`));
  const settings = await getSettings(env);
  const groups = await activeGroups(env);
  const stmts = [];
  for (const f of out.faces) {
    const row = await env.DB.prepare('INSERT INTO faces (photo_id, x, y, w, h, score, quality, q, s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(photoId, f.box[0], f.box[1], f.box[2], f.box[3], f.score, f.quality, f.emb.q, f.emb.s).first();
    if (f.crop) await env.PHOTOS.put(`crop/${row.id}.jpg`, b64ToBytes(f.crop), { httpMetadata: { contentType: 'image/jpeg' } });
    const outcomes = decideFace(settings, groups, decodeEmb(f.emb.q, f.emb.s), f.quality);
    stmts.push(...outcomeStatements(env, outcomes, row.id, photoId));
  }
  stmts.push(env.DB.prepare("UPDATE photos SET status = 'ready', w = ?, h = ?, face_count = ?, bytes = ? WHERE id = ?")
    .bind(out.w, out.h, out.faces.length, Math.floor(out.full.length * 0.75), photoId));
  await env.DB.batch(stmts);
  await env.PHOTOS.delete(`orig/${photoId}.jpg`);
}

/** Compare one face group against existing faces, in pages, re-queueing itself until done. */
export async function scanGroup(env, groupId, cursor = 0) {
  const groups = await activeGroups(env);
  const group = groups.find((g) => g.id === groupId);
  if (!group) return null;
  const settings = await getSettings(env);
  const PAGE = 2000;
  const { results } = await env.DB.prepare('SELECT id, photo_id, quality, q, s FROM faces WHERE id > ? ORDER BY id LIMIT ?').bind(cursor, PAGE).all();
  const stmts = [];
  for (const f of results) {
    const emb = decodeEmb(f.q, f.s);
    // Same decision as live processing, but against all groups so best-owner rule still holds
    const outcomes = decideFace(settings, groups, emb, f.quality).filter((o) => o.group.id === groupId);
    stmts.push(...outcomeStatements(env, outcomes, f.id, f.photo_id));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return results.length === PAGE ? results[results.length - 1].id : null;
}

export async function addTemplates(env, groupId, template, source = 'enroll') {
  const t = now();
  await env.DB.batch(template.map((e) =>
    env.DB.prepare('INSERT INTO templates (group_id, source, q, s, created_at) VALUES (?, ?, ?, ?, ?)').bind(groupId, source, e.q, e.s, t)));
  await bumpTemplatesVersion(env);
}

export { bytesToB64, HttpError };
