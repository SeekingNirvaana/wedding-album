import { Container } from '@cloudflare/containers';
import { CONFIG, allEvents } from './config.js';
import { HttpError, json, readJson, now, cleanName, ID_RE, SECURITY_HEADERS } from './lib/util.js';
import { getSettings } from './lib/store.js';
import { getSession, requireSession, startOtp, verifyOtp, firebaseSignIn, logout, adminUnlock } from './lib/auth.js';
import { createChallenge, submitChallenge, listFamily, removeFamily } from './lib/enroll.js';
import { upload, upgrade, list, counts, remove, listCandidates, answerCandidate, serveImage } from './lib/photos.js';
import { handleAdmin, deleteUser } from './lib/admin.js';
import { processPhoto, scanGroup } from './lib/faces.js';

/** Face service container. Internet access is off: it can only be reached through this Worker. */
export class FaceService extends Container {
  defaultPort = 8080;
  sleepAfter = '5m';
  enableInternet = false;
}

async function api(request, env, url, ctx) {
  const { pathname: path } = url;
  const method = request.method;

  // CSRF: every state-changing call must come from our own page
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = request.headers.get('origin');
    if (!origin || origin !== url.origin) throw new HttpError(403, 'Bad origin');
  }

  if (path === '/api/config' && method === 'GET') {
    return json({
      title: CONFIG.title, subtitle: CONFIG.subtitle, sides: CONFIG.sides, events: allEvents(),
      otpProvider: env.OTP_PROVIDER === 'firebase' ? 'firebase' : 'sms',
      turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
      firebase: env.OTP_PROVIDER === 'firebase' ? { apiKey: env.FIREBASE_API_KEY, projectId: env.FIREBASE_PROJECT_ID } : null,
    }, 200, { 'cache-control': 'public, max-age=300' });
  }
  if (path === '/api/auth/start' && method === 'POST') return startOtp(request, env);
  if (path === '/api/auth/verify' && method === 'POST') return verifyOtp(request, env);
  if (path === '/api/auth/firebase' && method === 'POST') return firebaseSignIn(request, env);
  if (path === '/api/auth/logout' && method === 'POST') return logout(request, env);

  const session = await requireSession(request, env);
  const u = session.user;

  if (path === '/api/me' && method === 'GET') {
    const settings = await getSettings(env);
    const [family, pending] = await Promise.all([
      listFamily(env, u.id),
      env.DB.prepare("SELECT COUNT(*) AS n FROM candidates WHERE user_id = ? AND status = 'pending'").bind(u.id).first(),
    ]);
    return json({
      user: { name: u.name, side: u.side, enrolled: u.enrolled, phoneLast4: u.phoneLast4, role: u.role },
      isAdmin: session.isAdmin, adminNeedsCode: session.adminNeedsCode,
      family, familyMax: Number(settings.family_max), pendingConfirmations: pending.n,
      uploadsOpen: settings.uploads_open === '1',
      enrollLockedUntil: u.enrollLockedUntil > now() ? u.enrollLockedUntil : 0,
    });
  }
  if (path === '/api/me' && method === 'PATCH') {
    const body = await readJson(request);
    const name = body.name !== undefined ? cleanName(body.name) || u.name : u.name;
    const side = ['groom', 'bride'].includes(body.side) ? body.side : u.side;
    await env.DB.prepare('UPDATE users SET name = ?, side = ? WHERE id = ?').bind(name, side, u.id).run();
    return json({ ok: true, name, side });
  }
  if (path === '/api/me' && method === 'DELETE') {
    const body = await readJson(request);
    if (u.role === 'admin') throw new HttpError(400, 'Admin accounts cannot be deleted from here');
    await deleteUser(env, u.id, body.deleteUploads === true);
    return json({ ok: true }, 200, { 'set-cookie': 'wa_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
  }
  if (path === '/api/admin/unlock' && method === 'POST') return adminUnlock(request, env);

  if (path === '/api/enroll/challenge' && method === 'POST') return createChallenge(request, env, session);
  if (path === '/api/enroll/submit' && method === 'POST') return submitChallenge(request, env, session);
  let m = path.match(/^\/api\/family\/([0-9a-f-]{36})$/);
  if (m && method === 'DELETE') { await removeFamily(env, u.id, m[1]); return json({ ok: true }); }

  if (path === '/api/photos' && method === 'POST') return upload(request, env, session, ctx);
  if (path === '/api/photos' && method === 'GET') return list(request, env, session);
  if (path === '/api/counts' && method === 'GET') return counts(request, env, session);
  m = path.match(/^\/api\/photos\/([0-9a-f-]{36})$/);
  if (m && method === 'DELETE') return remove(env, session, m[1]);
  m = path.match(/^\/api\/photos\/([0-9a-f-]{36})\/upgrade$/);
  if (m && method === 'PUT') return upgrade(request, env, session, m[1]);

  if (path === '/api/candidates' && method === 'GET') return listCandidates(env, session);
  m = path.match(/^\/api\/candidates\/(\d{1,12})$/);
  if (m && method === 'POST') return answerCandidate(request, env, session, Number(m[1]));

  if (path.startsWith('/api/admin/')) {
    if (!session.isAdmin) throw new HttpError(403, 'Admins only');
    return handleAdmin(request, env, session, url, ctx);
  }
  throw new HttpError(404, 'Not found');
}

async function scheduled(env) {
  const t = now();
  await env.DB.batch([
    // Accounts that never finished face setup do not hold a place for long
    env.DB.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE enrolled = 0 AND role = 'guest' AND created_at < ?)").bind(t - 86400_000),
    env.DB.prepare("DELETE FROM users WHERE enrolled = 0 AND role = 'guest' AND created_at < ? AND id NOT IN (SELECT uploader_id FROM photos)").bind(t - 86400_000),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
    env.DB.prepare('DELETE FROM otp_requests WHERE created_at < ?').bind(t - 86400_000),
    env.DB.prepare('DELETE FROM challenges WHERE created_at < ?').bind(t - 3600_000),
    env.DB.prepare('DELETE FROM rate WHERE win < ?').bind(t - 2 * 86400_000),
  ]);
  // Re-queue photos stuck in processing (e.g. after a failed deploy)
  const { results } = await env.DB.prepare("SELECT id FROM photos WHERE status = 'processing' AND created_at < ? LIMIT 200").bind(t - 30 * 60_000).all();
  for (const p of results) await env.JOBS.send({ type: 'process', photoId: p.id });
  // Retention: after the chosen date, delete all face data (photos and access stay)
  const settings = await getSettings(env, true);
  if (settings.retention_date && t > Date.parse(settings.retention_date + 'T00:00:00+05:30')) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM templates'),
      env.DB.prepare("UPDATE face_groups SET status = 'revoked'"),
      env.DB.prepare("DELETE FROM candidates"),
      env.DB.prepare("UPDATE faces SET q = '', s = 0"),
    ]);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(request, env, url, ctx);
      if (url.pathname.startsWith('/img/')) {
        const session = await getSession(request, env);
        if (!session) return new Response('Unauthorized', { status: 401, headers: SECURITY_HEADERS });
        return await serveImage(request, env, session, url);
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status, e.extra?.retryAfter ? { 'retry-after': String(e.extra.retryAfter) } : {});
      console.error(e);
      return json({ error: 'Something went wrong' }, 500);
    }
  },

  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        const job = msg.body || {};
        if (job.type === 'process' && ID_RE.test(job.photoId || '')) {
          await processPhoto(env, job.photoId, job.upgrade === true);
        } else if (job.type === 'scan' && ID_RE.test(job.groupId || '')) {
          const next = await scanGroup(env, job.groupId, Number(job.cursor) || 0);
          if (next) await env.JOBS.send({ type: 'scan', groupId: job.groupId, cursor: next });
        }
        msg.ack();
      } catch (e) {
        console.error('job failed', e);
        msg.retry({ delaySeconds: 30 });
      }
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduled(env));
  },
};
