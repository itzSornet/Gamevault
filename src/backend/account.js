/* GameVault account (Gamevault Cloud sign-in).
 *
 * Talks to Supabase Auth (GoTrue) over plain REST, like art-cache.js does, so
 * there is no supabase-js dependency. Two ways in, both PKCE through a
 * one-shot loopback server on 127.0.0.1 (allowed by additional_redirect_urls
 * in cloud/supabase/config.toml):
 *
 *   email   POST /otp sends a sign-in link (or a "confirm your email" link
 *           for a new address). Clicking it in a browser on this PC lands on
 *           http://127.0.0.1:<port>/auth/callback?code=… and we swap the code
 *           for a session.
 *   password  /token?grant_type=password. New accounts (/signup) and "forgot
 *           password" (/recover) confirm through an emailed link, same as
 *           above; after a reset link the app asks for a new password.
 *   google  (and any other OAuth provider once enabled in the dashboard)
 *           /authorize opens in the default browser, same callback.
 *
 * The session lives in <dir>/session.bin, encrypted with the injected
 * encrypt/decrypt (Electron safeStorage in main.js). Only the publishable key
 * is used here; nothing secret ships in the app.
 *
 * No Electron imports, so it can be tested with plain Node.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const PENDING_MS = 15 * 60 * 1000; // how long a sign-in link stays usable here
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function page(title, body, ok) {
  const color = ok ? '#4c7dff' : '#ff6b6b';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#08090c;color:#e8e9ee;font:15px/1.5 system-ui,Segoe UI,sans-serif}
main{text-align:center;max-width:420px;padding:24px}svg{color:${color}}h1{font-size:20px;margin:14px 0 6px}p{color:#9a9ca8;margin:0}</style></head>
<body><main><svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
<h1>${title}</h1><p>${body}</p></main></body></html>`;
}

// Errors on a redirect can come back in the URL fragment, which browsers never
// send to a server. This page moves them into the query and comes back.
const HASH_BOUNCE = `<!doctype html><meta charset="utf-8"><script>
var h=location.hash.slice(1);location.replace('/auth/callback?from_hash=1'+(h?'&'+h:''));
</script>`;

/**
 * @param {object} opts
 * @param {string} opts.dir
 * @param {string} [opts.cloudUrl]
 * @param {string} [opts.anonKey]
 * @param {Function} opts.openExternal  (url) => void, opens the default browser
 * @param {Function} [opts.encrypt]     (string) => string
 * @param {Function} [opts.decrypt]     (string) => string
 * @param {Function} [opts.onChange]    (status) => void, after sign-in/out or a failed link
 * @param {Function} [opts.fetch]
 * @param {Function} [opts.now]
 */
function createAccount(opts = {}) {
  const dir = opts.dir;
  if (!dir) throw new Error('createAccount: dir is required');
  const cloudUrl = String(opts.cloudUrl || '').replace(/\/+$/, '');
  const anonKey = String(opts.anonKey || '');
  const doFetch = opts.fetch || globalThis.fetch;
  const now = opts.now || Date.now;
  const encrypt = opts.encrypt || ((s) => 'p1:' + Buffer.from(s, 'utf8').toString('base64'));
  const decrypt = opts.decrypt || ((s) => (s.startsWith('p1:') ? Buffer.from(s.slice(3), 'base64').toString('utf8') : ''));
  const onChange = opts.onChange || (() => {});
  const openExternal = opts.openExternal || (() => {});
  const configured = () => !!(cloudUrl && anonKey);
  const FILE = path.join(dir, 'session.bin');

  let session; // undefined = not read yet, null = signed out
  let refreshJob = null;
  let pending = null; // { kind, email?, provider?, server, verifier, timer }
  let lastError = null;
  let providersCache = null;
  let mustSetPassword = false; // signed in through a "forgot password" link

  // ---------------------------------------------------------------- storage

  function readSession() {
    if (session !== undefined) return session;
    session = null;
    try {
      if (fs.existsSync(FILE)) {
        const parsed = JSON.parse(decrypt(fs.readFileSync(FILE, 'utf8').trim()) || 'null');
        if (parsed && parsed.refresh_token) session = parsed;
      }
    } catch (e) {
      console.warn('[account] session unreadable:', e.message);
    }
    return session;
  }

  function saveSession(next) {
    session = next;
    try {
      if (!next) { fs.rmSync(FILE, { force: true }); return; }
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, encrypt(JSON.stringify(next)));
      fs.renameSync(tmp, FILE);
    } catch (e) {
      console.warn('[account] session not saved:', e.message);
    }
  }

  // ------------------------------------------------------------------ http

  async function auth(method, pathAndQuery, body, bearer) {
    const headers = { apikey: anonKey, 'Content-Type': 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    let res;
    try {
      res = await doFetch(`${cloudUrl}/auth/v1/${pathAndQuery}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw Object.assign(new Error('Can’t reach Gamevault Cloud. Check your connection.'), { code: 'NETWORK' });
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const raw = (json && (json.msg || json.error_description || json.message || json.error)) || `Request failed (${res.status})`;
      const code = res.status === 429 ? 'RATE_LIMIT' : res.status >= 500 ? 'SERVER' : 'AUTH';
      throw Object.assign(new Error(friendly(raw, res.status)), { code, status: res.status });
    }
    return json;
  }

  function friendly(msg, status) {
    const m = String(msg);
    if (status === 429 || /rate limit/i.test(m)) return 'Too many sign-in emails right now. Wait a few minutes and try again.';
    // Supabase's built-in mailer only sends to the project's team members.
    if (/not authorized|email_address_not_authorized/i.test(m)) return 'GameVault can’t email that address yet. Use Continue with Google instead.';
    if (/invalid login credentials/i.test(m)) return 'Wrong email or password.';
    if (/email not confirmed/i.test(m)) return 'Confirm your email first: open the link we sent you, then sign in.';
    if (/already registered|already exists/i.test(m)) return 'There’s already an account with that email. Sign in instead.';
    if (/password.*(at least|short|weak)|weak password/i.test(m)) return 'Pick a longer password: at least 8 characters.';
    if (/same.*password|different from the old/i.test(m)) return 'Pick a password you haven’t used here before.';
    if (/invalid.*email|email.*invalid/i.test(m)) return 'That email address doesn’t look right.';
    if (/signups? not allowed/i.test(m)) return 'New accounts are turned off right now.';
    if (/provider is not enabled/i.test(m)) return 'That sign-in option isn’t turned on yet.';
    return m;
  }

  function toSession(json) {
    if (!json || !json.access_token || !json.refresh_token) {
      throw Object.assign(new Error('Sign-in didn’t return a session'), { code: 'AUTH' });
    }
    const u = json.user || {};
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: json.expires_at ? json.expires_at * 1000 : now() + (json.expires_in || 3600) * 1000,
      user: {
        id: u.id || null,
        email: u.email || null,
        provider: (u.app_metadata && u.app_metadata.provider) || null,
        name: (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) || null,
        avatar: (u.user_metadata && (u.user_metadata.avatar_url || u.user_metadata.picture)) || null,
        createdAt: u.created_at || null,
      },
    };
  }

  // ---------------------------------------------------------------- status

  function status() {
    const s = readSession();
    return {
      configured: configured(),
      signedIn: !!s,
      user: s ? s.user : null,
      pending: pending ? { kind: pending.kind, email: pending.email || null, provider: pending.provider || null } : null,
      mustSetPassword: !!s && mustSetPassword,
      error: lastError,
    };
  }

  function emit() {
    try { onChange(status()); } catch (_) {}
  }

  /** Which sign-in options the project has on (GET /settings, public). */
  async function providers() {
    if (!configured()) return { email: false, google: false };
    if (providersCache && providersCache.at > now() - 10 * 60 * 1000) return providersCache.value;
    try {
      const json = await auth('GET', 'settings');
      const ext = (json && json.external) || {};
      const value = { email: !!ext.email, google: !!ext.google, signupOpen: !json.disable_signup };
      providersCache = { at: now(), value };
      return value;
    } catch (_) {
      return providersCache ? providersCache.value : { email: true, google: false, signupOpen: true };
    }
  }

  // -------------------------------------------------------------- loopback

  function cancel() {
    if (!pending) return false;
    clearTimeout(pending.timer);
    try { pending.server.close(); } catch (_) {}
    pending = null;
    return true;
  }

  /** Start a one-shot callback server; resolves to its redirect URL. */
  function listen(entry) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => handleCallback(entry, req, res));
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        entry.server = server;
        entry.timer = setTimeout(() => {
          if (pending !== entry) return;
          cancel();
          lastError = 'The sign-in link expired. Send a new one.';
          emit();
        }, PENDING_MS);
        resolve(`http://127.0.0.1:${server.address().port}/auth/callback`);
      });
    });
  }

  async function handleCallback(entry, req, res) {
    const send = (code, html) => {
      res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    };
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch (_) { return send(400, 'Bad request'); }
    if (url.pathname !== '/auth/callback') return send(404, 'Not found');
    if (pending !== entry) {
      return send(410, page('This link was already used', 'Go back to GameVault and start sign-in again if you need to.', false));
    }
    const q = url.searchParams;
    const code = q.get('code');
    const err = q.get('error_description') || q.get('error');
    if (!code && !err) {
      if (!q.has('from_hash')) return send(200, HASH_BOUNCE);
      return send(400, page('Nothing to sign in with', 'Open the newest link from your email again.', false));
    }
    if (err) {
      const expired = /expired|invalid/i.test(err) || q.get('error_code') === 'otp_expired';
      lastError = expired ? 'That sign-in link has expired or was already used. Send a new one.' : String(err).replace(/\+/g, ' ');
      cancel();
      send(400, page('Sign-in didn’t work', lastError, false));
      emit();
      return;
    }
    try {
      const json = await auth('POST', 'token?grant_type=pkce', { auth_code: code, code_verifier: entry.verifier });
      saveSession(toSession(json));
      lastError = null;
      mustSetPassword = entry.kind === 'recovery';
      cancel();
      send(200, mustSetPassword
        ? page('Almost done', 'Go back to GameVault and choose a new password.', true)
        : page('You’re signed in', 'You can close this tab and go back to GameVault.', true));
    } catch (e) {
      lastError = e.message;
      cancel();
      send(400, page('Sign-in didn’t work', e.message, false));
    }
    emit();
  }

  function pkce() {
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
  }

  // ---------------------------------------------------------------- sign in

  function cleanEmail(email) {
    if (!configured()) throw Object.assign(new Error('Gamevault Cloud is turned off in this build'), { code: 'NO_CLOUD' });
    const addr = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(addr) || addr.length > 254) throw Object.assign(new Error('That email address doesn’t look right.'), { code: 'AUTH' });
    return addr;
  }

  function checkPassword(password) {
    const pw = String(password || '');
    if (pw.length < 8) throw Object.assign(new Error('Pick a longer password: at least 8 characters.'), { code: 'AUTH' });
    if (pw.length > 72) throw Object.assign(new Error('That password is too long (72 characters at most).'), { code: 'AUTH' });
    return pw;
  }

  /** Send an emailed link (kind: email | signup | recovery) and wait for it on loopback. */
  async function sendLink(kind, addr, endpoint, body) {
    cancel();
    const { verifier, challenge } = pkce();
    const entry = { kind, email: addr, verifier };
    const redirect = await listen(entry);
    pending = entry;
    let json;
    try {
      json = await auth('POST', `${endpoint}?redirect_to=${encodeURIComponent(redirect)}`, {
        ...body, email: addr, code_challenge: challenge, code_challenge_method: 's256',
      });
    } catch (e) {
      cancel();
      throw e;
    }
    // Projects with email confirmation off sign a new account straight in.
    if (json && json.access_token && json.refresh_token) {
      cancel();
      saveSession(toSession(json));
    }
    lastError = null;
    emit();
    return status();
  }

  /** Passwordless: a sign-in link (creates the account if it's new). */
  async function startEmail(email) {
    return sendLink('email', cleanEmail(email), 'otp', { create_user: true });
  }

  async function signUp(email, password) {
    return sendLink('signup', cleanEmail(email), 'signup', { password: checkPassword(password) });
  }

  async function resetPassword(email) {
    return sendLink('recovery', cleanEmail(email), 'recover', {});
  }

  async function signInPassword(email, password) {
    const addr = cleanEmail(email);
    const pw = String(password || '');
    if (!pw) throw Object.assign(new Error('Enter your password.'), { code: 'AUTH' });
    cancel();
    const json = await auth('POST', 'token?grant_type=password', { email: addr, password: pw });
    saveSession(toSession(json));
    mustSetPassword = false;
    lastError = null;
    emit();
    return status();
  }

  /** Set or change the signed-in user's password. */
  async function setPassword(password) {
    const pw = checkPassword(password);
    const access = await token();
    if (!access) throw Object.assign(new Error('Sign in first.'), { code: 'AUTH' });
    await auth('PUT', 'user', { password: pw }, access);
    mustSetPassword = false;
    lastError = null;
    emit();
    return status();
  }

  async function startOAuth(provider) {
    if (!configured()) throw Object.assign(new Error('Gamevault Cloud is turned off in this build'), { code: 'NO_CLOUD' });
    if (!/^[a-z_]{2,20}$/.test(String(provider))) throw Object.assign(new Error('Unknown sign-in option'), { code: 'AUTH' });
    cancel();
    const { verifier, challenge } = pkce();
    const entry = { kind: 'oauth', provider, verifier };
    const redirect = await listen(entry);
    pending = entry;
    const q = new URLSearchParams({
      provider,
      redirect_to: redirect,
      code_challenge: challenge,
      code_challenge_method: 's256',
    });
    openExternal(`${cloudUrl}/auth/v1/authorize?${q}`);
    lastError = null;
    emit();
    return status();
  }

  // ------------------------------------------------------------- session use

  /** The signed-in user's access token (refreshed as needed), or null. */
  async function token({ forceNew = false } = {}) {
    const s = readSession();
    if (!s) return null;
    if (!forceNew && s.access_token && s.expires_at - 60_000 > now()) return s.access_token;
    if (refreshJob) return refreshJob;
    refreshJob = (async () => {
      try {
        const json = await auth('POST', 'token?grant_type=refresh_token', { refresh_token: s.refresh_token });
        const next = toSession(json);
        if (!next.user.email && s.user) next.user = { ...s.user, ...Object.fromEntries(Object.entries(next.user).filter(([, v]) => v)) };
        saveSession(next);
        return next.access_token;
      } catch (e) {
        if (e.code === 'AUTH') { // refresh token revoked or expired: signed out elsewhere
          saveSession(null);
          lastError = 'You were signed out. Sign in again to use cloud features.';
          emit();
          return null;
        }
        throw e; // offline: keep the session for later
      }
    })().finally(() => { refreshJob = null; });
    return refreshJob;
  }

  async function signOut() {
    cancel();
    const s = readSession();
    if (s) {
      try {
        const access = s.expires_at - 30_000 > now() ? s.access_token : null;
        if (access) await auth('POST', 'logout?scope=local', {}, access);
      } catch (_) { /* signing out locally is what matters */ }
    }
    saveSession(null);
    mustSetPassword = false;
    lastError = null;
    emit();
    return status();
  }

  function clearError() { lastError = null; }

  return { configured, status, providers, startEmail, signUp, resetPassword, signInPassword, setPassword, startOAuth, cancel, token, signOut, clearError };
}

module.exports = { createAccount };
