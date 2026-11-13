import { HttpError, b64url, fromB64url, dec, enc } from './util.js';

const MC_BASE = 'https://cpaas.messagecentral.com';

// ---------------- Message Central VerifyNow ----------------
let mcToken = { value: null, at: 0 };

async function mcAuthToken(env, force = false) {
  if (env.MC_AUTH_TOKEN && !force) return env.MC_AUTH_TOKEN;
  if (!force && mcToken.value && Date.now() - mcToken.at < 6 * 3600_000) return mcToken.value;
  if (!env.MC_CUSTOMER_ID || !env.MC_KEY_B64) throw new HttpError(500, 'SMS provider not configured');
  const u = new URL(MC_BASE + '/auth/v1/authentication/token');
  u.searchParams.set('customerId', env.MC_CUSTOMER_ID.trim());
  u.searchParams.set('key', env.MC_KEY_B64.trim());
  u.searchParams.set('scope', 'NEW');
  u.searchParams.set('country', '91');
  const r = await fetch(u, { headers: { accept: '*/*' } });
  const raw = await r.text().catch(() => '');
  let j = null; try { j = JSON.parse(raw); } catch {}
  // Their docs show two response shapes: { token } and { responseCode, data: { authToken } }.
  const tok = j?.token || j?.data?.authToken || j?.authToken || null;
  if (!r.ok || !tok) {
    // Logged for the owner (Cloudflare → wedding-album → Observability). Never contains the key.
    console.error('MC token failed', JSON.stringify({ http: r.status, body: raw.slice(0, 300), customerIdLooksRight: /^C-[A-Z0-9]+$/i.test(env.MC_CUSTOMER_ID.trim()), keyLength: env.MC_KEY_B64.length, keyHasSpaces: /\s/.test(env.MC_KEY_B64) }));
    throw new HttpError(502, `SMS provider login failed (${j?.responseCode ?? j?.status ?? r.status})`);
  }
  mcToken = { value: tok, at: Date.now() };
  return tok;
}

async function mcCall(env, path, params, method) {
  const u = new URL(MC_BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  let token = await mcAuthToken(env);
  let r = await fetch(u, { method, headers: { authToken: token } });
  if (r.status === 405) { method = method === 'GET' ? 'POST' : 'GET'; r = await fetch(u, { method, headers: { authToken: token } }); }
  if (r.status === 401 && !env.MC_AUTH_TOKEN) {
    token = await mcAuthToken(env, true);
    r = await fetch(u, { method, headers: { authToken: token } });
  }
  const j = await r.json().catch(() => null);
  return { http: r.status, body: j };
}

export async function mcSend(env, mobile10) {
  const { http, body } = await mcCall(env, '/verification/v3/send', {
    countryCode: '91', customerId: (env.MC_CUSTOMER_ID || '').trim(), flowType: 'SMS', mobileNumber: mobile10, otpLength: '6',
  }, 'POST');
  const code = body?.responseCode;
  if (http === 200 && String(code) === '200' && body?.data?.verificationId) return String(body.data.verificationId);
  if (String(code) === '506') throw new HttpError(429, 'A code was just sent. Please wait a minute and try again.');
  if (String(code) === '800') throw new HttpError(429, 'Too many codes for this number today.');
  console.error('mc send failed', http, code, body?.message);
  throw new HttpError(502, 'Could not send the code. Please try again.');
}

/** Returns 'ok' | 'wrong' | 'expired' */
export async function mcVerify(env, mobile10, verificationId, code) {
  const { http, body } = await mcCall(env, '/verification/v3/validateOtp', {
    countryCode: '91', mobileNumber: mobile10, verificationId, customerId: (env.MC_CUSTOMER_ID || '').trim(), code, flowType: 'SMS',
  }, 'GET');
  const rc = String(body?.responseCode ?? body?.data?.responseCode ?? '');
  if (http === 200 && rc === '200' && body?.data?.verificationStatus === 'VERIFICATION_COMPLETED') return 'ok';
  if (rc === '702') return 'wrong';
  if (rc === '705' || rc === '703') return 'expired';
  if (rc === '700') return 'wrong';
  console.error('mc verify failed', http, rc, body?.message);
  throw new HttpError(502, 'Could not check the code. Please try again.');
}

// ---------------- Firebase Phone Auth (fallback) ----------------
// The browser completes the SMS step with Firebase; we only verify the resulting ID token.
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwks = { keys: null, at: 0, ttl: 3600_000 };

async function firebaseKeys() {
  if (jwks.keys && Date.now() - jwks.at < jwks.ttl) return jwks.keys;
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new HttpError(502, 'Could not reach Google to verify sign-in');
  const j = await r.json();
  const m = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  jwks = { keys: j.keys || [], at: Date.now(), ttl: m ? Number(m[1]) * 1000 : 3600_000 };
  return jwks.keys;
}

export async function verifyFirebaseIdToken(env, token) {
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new HttpError(500, 'Firebase not configured');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Invalid sign-in token');
  let header, payload;
  try {
    header = JSON.parse(dec.decode(fromB64url(parts[0])));
    payload = JSON.parse(dec.decode(fromB64url(parts[1])));
  } catch {
    throw new HttpError(401, 'Invalid sign-in token');
  }
  if (header.alg !== 'RS256') throw new HttpError(401, 'Invalid sign-in token');
  const jwk = (await firebaseKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new HttpError(401, 'Invalid sign-in token');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  const t = Math.floor(Date.now() / 1000);
  if (!ok || payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}` ||
      !payload.sub || payload.exp < t || payload.iat > t + 60 || !payload.phone_number) {
    throw new HttpError(401, 'Invalid sign-in token');
  }
  // Only accept tokens minted in the last 10 minutes, so an old token cannot be replayed later
  if (payload.auth_time && t - payload.auth_time > 600) throw new HttpError(401, 'Sign-in expired, please try again');
  return payload.phone_number; // E.164, e.g. +9198xxxxxxxx
}

export function normalizeIndianMobile(input) {
  const d = String(input || '').replace(/\D/g, '');
  const ten = d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d;
  if (!/^[6-9]\d{9}$/.test(ten)) return null;
  return ten;
}

export { b64url };
