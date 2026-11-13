import { HttpError, now } from './util.js';

const DEFAULTS = {
  signup_cap: '1000',
  family_max: '2',
  family_approval: 'off',
  uploads_open: '1',
  upload_daily_cap: '300',
  sms_daily_budget: '1500',
  login_daily_cap: '5',
  match_confident: '0.45',
  match_possible: '0.32',
  retention_date: '',
  templates_version: '1',
};

let cache = { at: 0, value: null };

export async function getSettings(env, fresh = false) {
  if (!fresh && cache.value && now() - cache.at < 15_000) return cache.value;
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULTS };
  for (const r of results) s[r.key] = r.value;
  cache = { at: now(), value: s };
  return s;
}

export async function setSettings(env, patch) {
  const stmts = Object.entries(patch).map(([k, v]) =>
    env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, String(v)));
  if (stmts.length) await env.DB.batch(stmts);
  cache = { at: 0, value: null };
  return getSettings(env, true);
}

export async function bumpTemplatesVersion(env) {
  await env.DB.prepare("UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'templates_version'").run();
  cache = { at: 0, value: null };
}

/**
 * Fixed-window counter. Returns { ok, n } and counts the attempt.
 * key examples: otp:phone:<hmac>, otp:ip:<ip>, sms:day:<yyyymmdd>
 */
export async function hit(env, key, limit, windowSec, amount = 1) {
  const t = now();
  const windowStart = Math.floor(t / (windowSec * 1000)) * windowSec * 1000;
  const row = await env.DB.prepare(
    `INSERT INTO rate (k, win, n) VALUES (?1, ?2, ?3)
     ON CONFLICT(k) DO UPDATE SET n = CASE WHEN win = ?2 THEN n + ?3 ELSE ?3 END, win = ?2
     RETURNING n`
  ).bind(key, windowStart, amount).first();
  return { ok: row.n <= limit, n: row.n, retryAfter: Math.ceil((windowStart + windowSec * 1000 - t) / 1000) };
}

export async function peek(env, key, windowSec) {
  const windowStart = Math.floor(now() / (windowSec * 1000)) * windowSec * 1000;
  const row = await env.DB.prepare('SELECT win, n FROM rate WHERE k = ?').bind(key).first();
  return row && row.win === windowStart ? row.n : 0;
}

export async function limitOrThrow(env, key, limit, windowSec, message) {
  const r = await hit(env, key, limit, windowSec);
  if (!r.ok) throw new HttpError(429, message || 'Too many requests, please wait a bit', { retryAfter: r.retryAfter });
  return r;
}

export async function audit(env, adminId, action, target, detail) {
  await env.DB.prepare('INSERT INTO audit (admin_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(adminId, action, target || null, detail ? JSON.stringify(detail).slice(0, 2000) : null, now()).run();
}

export async function flag(env, kind, userId, detail) {
  await env.DB.prepare('INSERT INTO flags (kind, user_id, detail, created_at) VALUES (?, ?, ?, ?)')
    .bind(kind, userId || null, detail ? JSON.stringify(detail).slice(0, 2000) : null, now()).run();
}
