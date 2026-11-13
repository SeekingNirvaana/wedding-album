import { HttpError, json, readJson, now, randomToken, sha256hex, hmacHex, encryptText, decryptText,
  cleanName, clientIp, requireSecret, timingSafeEqualText } from './util.js';
import { getSettings, hit, limitOrThrow, audit, peek } from './store.js';
import { mcSend, mcVerify, verifyFirebaseIdToken, normalizeIndianMobile } from './otp.js';

const COOKIE = 'wa_session';
const SESSION_DAYS = 45;
const ADMIN_ELEVATION_MS = 12 * 3600_000;

const isDev = (env) => env.ENVIRONMENT === 'development';
export const ACCESS = ['guest', 'family', 'inner', 'helper'];

function cookieHeader(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function phoneHmac(env, ten) {
  return hmacHex(requireSecret(env, 'PHONE_PEPPER'), '+91' + ten);
}

async function adminPhoneSet(env) {
  const list = String(env.ADMIN_PHONES || '').split(',').map((p) => normalizeIndianMobile(p)).filter(Boolean);
  return new Set(await Promise.all(list.map((t) => phoneHmac(env, t))));
}

// ---------------- sessions ----------------
export async function getSession(request, env) {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,})`));
  if (!m) return null;
  const th = await sha256hex(m[1]);
  const row = await env.DB.prepare(
    `SELECT s.token_hash, s.elevated_until, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
  ).bind(th).first();
  if (!row || row.expires_at < now() || row.status !== 'active') return null;
  if (!row.last_seen || now() - row.last_seen > 3600_000) {
    await env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(now(), row.id).run();
  }
  const isAdmin = row.role === 'admin' && row.elevated_until > now();
  // What this person may see: admins always see everything; others get the level set in the People list
  const access = row.role === 'admin' ? 'inner' : ACCESS.includes(row.access) ? row.access : 'guest';
  return {
    tokenHash: th,
    user: { id: row.id, name: row.name, side: row.side, role: row.role, enrolled: !!row.enrolled, phoneLast4: row.phone_last4,
      livenessMode: row.liveness_mode, enrollLockedUntil: row.enroll_locked_until },
    access,
    isAdmin,
    canModerate: isAdmin || row.access === 'helper',
    adminNeedsCode: row.role === 'admin' && row.elevated_until <= now(),
  };
}

export async function requireSession(request, env) {
  const s = await getSession(request, env);
  if (!s) throw new HttpError(401, 'Please sign in');
  return s;
}

export async function requireAdmin(request, env) {
  const s = await requireSession(request, env);
  if (!s.isAdmin) throw new HttpError(403, 'Admins only');
  return s;
}

async function createSession(env, userId) {
  const token = randomToken(32);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256hex(token), userId, now(), now() + SESSION_DAYS * 86400_000).run();
  return cookieHeader(token, SESSION_DAYS * 86400);
}

// ---------------- turnstile ----------------
async function checkTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) {
    if (isDev(env)) return;
    throw new HttpError(500, 'Server not configured: TURNSTILE_SECRET');
  }
  if (!token || typeof token !== 'string' || token.length > 2048) throw new HttpError(400, 'Please complete the check');
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new HttpError(400, 'Security check failed, please try again');
}

// ---------------- sign-up capacity ----------------
async function checkCapacity(env, isNew) {
  if (!isNew) return;
  const s = await getSettings(env);
  const cap = Number(s.signup_cap) || 1000;
  const [{ active }, { pending }] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS active FROM users WHERE enrolled = 1 AND status = 'active'").first(),
    env.DB.prepare('SELECT COUNT(*) AS pending FROM users WHERE enrolled = 0 AND listed = 0 AND created_at > ?').bind(now() - 86400_000).first(),
  ]);
  if (active >= cap) throw new HttpError(403, 'The album is full right now. Please ask the family to make room.', { code: 'full' });
  if (pending >= Math.max(100, Math.floor(cap * 0.25))) throw new HttpError(429, 'Lots of people are joining right now. Please try again in an hour.', { code: 'busy' });
}

// ---------------- routes ----------------
export async function startOtp(request, env) {
  const body = await readJson(request);
  const ten = normalizeIndianMobile(body.phone);
  if (!ten) throw new HttpError(400, 'Please enter a 10-digit Indian mobile number');
  const ip = clientIp(request);
  await checkTurnstile(env, body.turnstile, request.headers.get('cf-connecting-ip'));

  const ph = await phoneHmac(env, ten);
  await limitOrThrow(env, `otp:ip:${ip}`, 25, 3600, 'Too many codes requested from this network. Try again later.');
  await limitOrThrow(env, `otp:phd:${ph}`, 8, 86400, 'Too many codes for this number today.');
  // Escalating resend wait: 30 s, then 60 s, then 5 min
  const last = await env.DB.prepare('SELECT created_at FROM otp_requests WHERE phone_hmac = ? ORDER BY created_at DESC LIMIT 1').bind(ph).first();
  const recent = await peek(env, `otp:ph:${ph}`, 3600);
  const wait = recent >= 3 ? 300_000 : recent >= 2 ? 60_000 : 30_000;
  if (last && now() - last.created_at < wait) {
    throw new HttpError(429, 'Please wait before asking for another code', { retryAfter: Math.ceil((wait - (now() - last.created_at)) / 1000) });
  }
  await hit(env, `otp:ph:${ph}`, 1000, 3600);

  const existing = await env.DB.prepare('SELECT id, status FROM users WHERE phone_hmac = ?').bind(ph).first();
  if (existing?.status === 'banned') throw new HttpError(403, 'This number cannot sign in');
  await checkCapacity(env, !existing);

  const settings = await getSettings(env);
  const day = new Date().toISOString().slice(0, 10);
  const budget = await hit(env, `sms:day:${day}`, Number(settings.sms_daily_budget) || 1500, 86400);
  if (!budget.ok) throw new HttpError(503, 'Sign-in codes are paused for today. Please try again tomorrow.');

  const provider = isDev(env) && env.OTP_PROVIDER === 'dev' ? 'dev' : env.OTP_PROVIDER === 'firebase' ? 'firebase' : 'messagecentral';
  if (provider === 'firebase') {
    // The browser sends the SMS through Firebase; nothing to do here except rate limiting.
    return json({ provider: 'firebase', resendAfter: 30 });
  }
  const ref = provider === 'dev' ? 'dev' : await mcSend(env, ten);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO otp_requests (id, phone_hmac, phone_enc, provider, provider_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, ph, await encryptText(requireSecret(env, 'PHONE_PEPPER'), ten), provider, ref, now()).run();
  return json({ provider, requestId: id, resendAfter: wait / 1000 });
}

async function signInPhone(env, ten, body) {
  const ph = await phoneHmac(env, ten);
  let user = await env.DB.prepare('SELECT * FROM users WHERE phone_hmac = ?').bind(ph).first();
  if (user?.status === 'banned') throw new HttpError(403, 'This number cannot sign in');
  const admins = await adminPhoneSet(env);
  const role = admins.has(ph) ? 'admin' : 'guest';
  if (!user) {
    if (body.consent !== true) throw new HttpError(400, 'Please accept the privacy notice to continue', { code: 'consent' });
    await checkCapacity(env, true);
    const id = crypto.randomUUID();
    const side = ['groom', 'bride'].includes(body.side) ? body.side : 'groom';
    await env.DB.prepare(
      'INSERT INTO users (id, phone_hmac, phone_last4, name, side, role, consent_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, ph, ten.slice(-4), cleanName(body.name) || 'Guest', side, role, now(), now()).run();
    user = { id };
  } else {
    // Pre-listed by the couple and signing in for the first time: record consent, keep the listed name and side
    if (!user.consent_at) {
      if (body.consent !== true) throw new HttpError(400, 'Please accept the privacy notice to continue', { code: 'consent' });
      const name = user.name || cleanName(body.name) || 'Guest';
      await env.DB.prepare('UPDATE users SET consent_at = ?, name = ? WHERE id = ?').bind(now(), name, user.id).run();
    }
    if (user.role !== role) await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, user.id).run();
  }
  return createSession(env, user.id);
}

export async function verifyOtp(request, env) {
  const body = await readJson(request);
  const code = String(body.code || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'Enter the 6-digit code');
  const row = await env.DB.prepare('SELECT * FROM otp_requests WHERE id = ?').bind(String(body.requestId || '')).first();
  if (!row || row.status !== 'sent' || now() - row.created_at > 5 * 60_000) throw new HttpError(400, 'This code has expired. Please ask for a new one.', { code: 'expired' });
  if (row.attempts >= 5) throw new HttpError(429, 'Too many wrong tries. Please ask for a new code.', { code: 'expired' });
  // Check sign-up preconditions before using up the code
  const known = await env.DB.prepare('SELECT consent_at FROM users WHERE phone_hmac = ?').bind(row.phone_hmac).first();
  if (!known || !known.consent_at) {
    if (body.consent !== true) throw new HttpError(400, 'Please accept the privacy notice to continue', { code: 'consent' });
    if (!known) await checkCapacity(env, true);
  }
  await env.DB.prepare('UPDATE otp_requests SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();

  const ten = await decryptText(requireSecret(env, 'PHONE_PEPPER'), row.phone_enc);
  let result;
  if (row.provider === 'dev') result = isDev(env) && code === '000000' ? 'ok' : 'wrong';
  else result = await mcVerify(env, ten, row.provider_ref, code);
  if (result === 'expired') {
    await env.DB.prepare("UPDATE otp_requests SET status = 'failed', phone_enc = '' WHERE id = ?").bind(row.id).run();
    throw new HttpError(400, 'This code has expired. Please ask for a new one.', { code: 'expired' });
  }
  if (result !== 'ok') throw new HttpError(400, 'That code is not right', { attemptsLeft: Math.max(0, 4 - row.attempts) });
  await env.DB.prepare("UPDATE otp_requests SET status = 'verified', phone_enc = '' WHERE id = ?").bind(row.id).run();
  const cookie = await signInPhone(env, ten, body);
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}

export async function firebaseSignIn(request, env) {
  if (env.OTP_PROVIDER !== 'firebase') throw new HttpError(404, 'Not found');
  const body = await readJson(request, 16 * 1024);
  await limitOrThrow(env, `fb:ip:${clientIp(request)}`, 30, 3600);
  const e164 = await verifyFirebaseIdToken(env, body.idToken);
  const ten = normalizeIndianMobile(e164);
  if (!ten) throw new HttpError(400, 'Only Indian mobile numbers are supported');
  const cookie = await signInPhone(env, ten, body);
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}

export async function logout(request, env) {
  const s = await getSession(request, env);
  if (s) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(s.tokenHash).run();
  return json({ ok: true }, 200, { 'set-cookie': cookieHeader('', 0) });
}

export async function adminUnlock(request, env) {
  const s = await requireSession(request, env);
  if (s.user.role !== 'admin') throw new HttpError(403, 'Admins only');
  await limitOrThrow(env, `admincode:${s.user.id}`, 6, 1800, 'Too many wrong attempts. Try again in 30 minutes.');
  const body = await readJson(request);
  const ok = await timingSafeEqualText(String(body.code || '').trim(), requireSecret(env, 'ADMIN_CODE'));
  if (!ok) throw new HttpError(401, 'Wrong admin passcode');
  await env.DB.prepare('UPDATE sessions SET elevated_until = ? WHERE token_hash = ?').bind(now() + ADMIN_ELEVATION_MS, s.tokenHash).run();
  await audit(env, s.user.id, 'admin_unlock');
  return json({ ok: true });
}
