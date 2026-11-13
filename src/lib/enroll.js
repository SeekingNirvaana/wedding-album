import { HttpError, json, readJson, now, cleanName } from './util.js';
import { getSettings, limitOrThrow, flag, bumpTemplatesVersion } from './store.js';
import { callFace, activeGroups, decodeEmb, groupScore, addTemplates } from './faces.js';

const UNIQUE_THRESHOLD = 0.5;
const MAX_FAILS = 4;
const LOCK_MS = 3600_000;

function randomSequence() {
  const turns = crypto.getRandomValues(new Uint8Array(1))[0] % 2 ? ['left', 'right'] : ['right', 'left'];
  return ['center', turns[0], 'center', turns[1]];
}

export async function createChallenge(request, env, session) {
  const body = await readJson(request);
  const purpose = body.purpose === 'family' ? 'family' : 'self';
  const u = session.user;
  if (u.enrollLockedUntil > now()) {
    throw new HttpError(429, 'Too many tries. Please wait a while and try again.', { retryAfter: Math.ceil((u.enrollLockedUntil - now()) / 1000) });
  }
  if (purpose === 'self' && u.enrolled) throw new HttpError(409, 'Your face is already set up');
  if (purpose === 'family') {
    if (!u.enrolled) throw new HttpError(409, 'Set up your own face first');
    const settings = await getSettings(env);
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM face_groups WHERE user_id = ? AND kind = 'family' AND status != 'revoked'").bind(u.id).first();
    if (n >= Number(settings.family_max)) throw new HttpError(403, `You can add up to ${settings.family_max} family members`);
  }
  await limitOrThrow(env, `chal:${u.id}`, 12, 3600, 'Too many tries. Please wait a while.');
  const id = crypto.randomUUID();
  const sequence = randomSequence();
  await env.DB.prepare('INSERT INTO challenges (id, user_id, purpose, label, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, u.id, purpose, purpose === 'family' ? cleanName(body.label) || 'Family' : null, JSON.stringify(sequence), now()).run();
  return json({ challengeId: id, sequence, expiresIn: 120 });
}

async function registerFail(env, userId, reason) {
  const row = await env.DB.prepare('UPDATE users SET enroll_fails = enroll_fails + 1 WHERE id = ? RETURNING enroll_fails').bind(userId).first();
  if (row.enroll_fails >= MAX_FAILS) {
    await env.DB.prepare('UPDATE users SET enroll_fails = 0, enroll_locked_until = ? WHERE id = ?').bind(now() + LOCK_MS, userId).run();
    await flag(env, 'liveness_lock', userId, { reason });
  }
}

export async function submitChallenge(request, env, session) {
  const body = await readJson(request, 3 * 1024 * 1024);
  const u = session.user;
  const ch = await env.DB.prepare('SELECT * FROM challenges WHERE id = ? AND user_id = ?').bind(String(body.challengeId || ''), u.id).first();
  if (!ch || ch.used || now() - ch.created_at > 120_000) throw new HttpError(400, 'This check expired. Please start again.', { code: 'expired' });
  await env.DB.prepare('UPDATE challenges SET used = 1 WHERE id = ?').bind(ch.id).run();
  const sequence = JSON.parse(ch.sequence);
  const frames = Array.isArray(body.frames) ? body.frames : [];
  if (frames.length !== sequence.length || frames.some((f) => typeof f !== 'string' || f.length > 500_000)) throw new HttpError(400, 'Bad frames');
  const mode = body.mode === 'stills' ? 'stills' : 'live';

  const res = await callFace(env, '/liveness', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sequence, frames }),
  });
  if (!res.ok) throw new HttpError(502, 'Face check is busy, please try again');
  const out = await res.json();
  if (!out.pass) {
    await registerFail(env, u.id, out.reason);
    return json({ ok: false, reason: out.reason });
  }

  // One face, one account: block faces already enrolled by anyone
  const groups = await activeGroups(env);
  const center = decodeEmb(out.template[0].q, out.template[0].s);
  const pendingGroups = await env.DB.prepare(
    `SELECT g.id, g.user_id, t.q, t.s FROM face_groups g JOIN templates t ON t.group_id = g.id WHERE g.status = 'pending'`).all();
  let clash = null;
  for (const g of groups) { const s = groupScore(g, center); if (s >= UNIQUE_THRESHOLD && (!clash || s > clash.score)) clash = { userId: g.userId, score: s }; }
  for (const r of pendingGroups.results) { const s = groupScore({ vecs: [decodeEmb(r.q, r.s)] }, center); if (s >= UNIQUE_THRESHOLD) clash = clash || { userId: r.user_id, score: s }; }
  if (clash) {
    await flag(env, 'face_already_enrolled', u.id, { otherUser: clash.userId, score: Math.round(clash.score * 1000) / 1000, purpose: ch.purpose });
    return json({ ok: false, reason: 'already_enrolled' });
  }

  const settings = await getSettings(env);
  const groupId = crypto.randomUUID();
  const status = ch.purpose === 'family' && settings.family_approval === 'on' ? 'pending' : 'active';
  await env.DB.prepare('INSERT INTO face_groups (id, user_id, kind, label, status, liveness_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(groupId, u.id, ch.purpose, ch.label, status, mode, now()).run();
  await addTemplates(env, groupId, out.template);
  if (ch.purpose === 'self') {
    await env.DB.prepare('UPDATE users SET enrolled = 1, liveness_mode = ?, enroll_fails = 0 WHERE id = ?').bind(mode, u.id).run();
  }
  if (status === 'active') await env.JOBS.send({ type: 'scan', groupId, cursor: 0 });
  return json({ ok: true, groupId, status });
}

export async function listFamily(env, userId) {
  const { results } = await env.DB.prepare(
    "SELECT id, label, status, created_at FROM face_groups WHERE user_id = ? AND kind = 'family' AND status != 'revoked' ORDER BY created_at").bind(userId).all();
  return results;
}

export async function removeFamily(env, userId, groupId) {
  const r = await env.DB.prepare("UPDATE face_groups SET status = 'revoked' WHERE id = ? AND user_id = ? AND kind = 'family'").bind(groupId, userId).run();
  if (!r.meta.changes) throw new HttpError(404, 'Not found');
  await env.DB.batch([
    env.DB.prepare("DELETE FROM access WHERE user_id = ? AND group_id = ? AND reason != 'upload'").bind(userId, groupId),
    env.DB.prepare('DELETE FROM candidates WHERE user_id = ? AND group_id = ?').bind(userId, groupId),
    env.DB.prepare('DELETE FROM templates WHERE group_id = ?').bind(groupId),
  ]);
  await bumpTemplatesVersion(env);
}
