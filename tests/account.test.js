// Plain-Node tests for src/backend/account.js: node tests/account.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createAccount } = require('../src/backend/account.js');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fakeCloud() {
  const calls = [];
  let challenge = null;
  let refreshOk = true;
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const session = (email) => ({
    access_token: 'acc-' + crypto.randomBytes(4).toString('hex'), refresh_token: 'ref-1', expires_in: 3600,
    user: { id: 'u1', email, app_metadata: { provider: 'email' }, created_at: '2026-11-10T00:00:00Z' },
  });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: u.pathname + u.search, body });
    if (u.pathname === '/functions/v1/delete-account') return json(200, { ok: true });
    const p = u.pathname.replace('/auth/v1/', '');
    if (p === 'settings') return json(200, { external: { email: true, google: true }, disable_signup: false });
    if (p === 'otp') {
      if (body.email === 'limit@x.io') return json(429, { msg: 'email rate limit exceeded' });
      challenge = body.code_challenge;
      return json(200, {});
    }
    if (p === 'token' && u.searchParams.get('grant_type') === 'pkce') {
      const ok = challenge && b64url(crypto.createHash('sha256').update(body.code_verifier).digest()) === challenge && body.auth_code === 'good';
      return ok ? json(200, session('me@x.io')) : json(400, { msg: 'invalid flow state' });
    }
    if (p === 'token' && u.searchParams.get('grant_type') === 'refresh_token') {
      return refreshOk ? json(200, session('me@x.io')) : json(400, { msg: 'Invalid Refresh Token' });
    }
    if (p === 'signup' || p === 'recover') { challenge = body.code_challenge; return json(200, { id: 'u1', email: body.email }); }
    if (p === 'token' && u.searchParams.get('grant_type') === 'password') {
      return body.password === 'right-password' ? json(200, session(body.email)) : json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    }
    if (p === 'user' && init.method === 'PUT') return json(200, { id: 'u1' });
    if (p === 'verify') return body.token === '123456' ? json(200, session(body.email)) : json(403, { msg: 'Token has expired or is invalid' });
    if (p === 'logout') return { ok: true, status: 204, json: async () => { throw new Error('no body'); } };
    return json(404, { msg: 'nope' });
  };
  return { fetch, calls, setRefresh: (v) => { refreshOk = v; } };
}

async function get(url) {
  const res = await globalThis.fetch(url);
  return { status: res.status, text: await res.text() };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-acct-'));
  const cloud = fakeCloud();
  const changes = [];
  let t = Date.now();
  const mk = () => createAccount({ dir, cloudUrl: 'https://x.supabase.co', anonKey: 'pk', fetch: cloud.fetch, now: () => t, onChange: (s) => changes.push(s) });
  let acct = mk();

  assert.deepStrictEqual((await acct.providers()).google, true);
  assert.strictEqual(acct.status().signedIn, false);

  // bad email / rate limit
  await assert.rejects(acct.startEmail('nope'), /doesn’t look right/);
  await assert.rejects(acct.startEmail('limit@x.io'), /Too many/);
  assert.strictEqual(acct.status().pending, null, 'failed send leaves nothing pending');

  // email link flow
  await acct.startEmail('Me@X.io');
  const otp = cloud.calls.filter((c) => c.path.startsWith('/auth/v1/otp')).pop();
  const redirect = new URL(otp.path, 'https://x').searchParams.get('redirect_to');
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  assert.strictEqual(otp.body.email, 'me@x.io');
  assert.strictEqual(acct.status().pending.email, 'me@x.io');

  // a fragment-only redirect gets bounced into the query
  const bounce = await get(redirect);
  assert.match(bounce.text, /from_hash=1/);
  const r = await get(redirect + '?code=good');
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /signed in/);
  const st = acct.status();
  assert.strictEqual(st.signedIn, true);
  assert.strictEqual(st.user.email, 'me@x.io');
  assert.strictEqual(st.pending, null);
  assert.ok(changes.some((c) => c.signedIn));
  await assert.rejects(get(redirect), 'server closed after use');

  // persisted, not in plain text
  const raw = fs.readFileSync(path.join(dir, 'session.bin'), 'utf8');
  assert.ok(!raw.includes('ref-1'));
  acct = mk();
  assert.strictEqual(acct.status().user.email, 'me@x.io');
  assert.ok(await acct.token());

  // expired token refreshes
  t += 2 * 3600 * 1000;
  const tok = await acct.token();
  assert.ok(tok && tok.startsWith('acc-'));
  assert.ok(cloud.calls.some((c) => c.path.includes('grant_type=refresh_token')));

  // revoked refresh token signs out
  t += 2 * 3600 * 1000;
  cloud.setRefresh(false);
  assert.strictEqual(await acct.token(), null);
  assert.strictEqual(acct.status().signedIn, false);
  assert.match(acct.status().error, /signed out/);
  cloud.setRefresh(true);

  // error on the link
  await acct.startEmail('me@x.io');
  const redir2 = new URL(cloud.calls.filter((c) => c.path.startsWith('/auth/v1/otp')).pop().path, 'https://x').searchParams.get('redirect_to');
  const e = await get(redir2 + '?from_hash=1&error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  assert.strictEqual(e.status, 400);
  assert.match(acct.status().error, /expired/);
  assert.strictEqual(acct.status().pending, null);

  // wrong code
  await acct.startEmail('me@x.io');
  const redir3 = new URL(cloud.calls.filter((c) => c.path.startsWith('/auth/v1/otp')).pop().path, 'https://x').searchParams.get('redirect_to');
  await get(redir3 + '?code=bad');
  assert.strictEqual(acct.status().signedIn, false);

  // oauth + sign out
  let opened = null;
  acct = createAccount({ dir, cloudUrl: 'https://x.supabase.co', anonKey: 'pk', fetch: cloud.fetch, now: () => t, openExternal: (u) => { opened = u; } });
  await acct.startOAuth('google');
  const ou = new URL(opened);
  assert.strictEqual(ou.pathname, '/auth/v1/authorize');
  assert.strictEqual(ou.searchParams.get('provider'), 'google');
  assert.strictEqual(ou.searchParams.get('code_challenge_method'), 's256');
  acct.cancel();
  assert.strictEqual(acct.status().pending, null);
  await acct.startEmail('me@x.io');
  const redir4 = new URL(cloud.calls.filter((c) => c.path.startsWith('/auth/v1/otp')).pop().path, 'https://x').searchParams.get('redirect_to');
  await get(redir4 + '?code=good');
  assert.strictEqual(acct.status().signedIn, true);
  await acct.signOut();
  assert.strictEqual(acct.status().signedIn, false);
  assert.ok(!fs.existsSync(path.join(dir, 'session.bin')));

  // password sign-in, sign-up, reset
  await assert.rejects(acct.signInPassword('me@x.io', 'nope'), /Wrong email or password/);
  await acct.signInPassword('me@x.io', 'right-password');
  assert.strictEqual(acct.status().signedIn, true);
  await assert.rejects(acct.setPassword('short'), /at least 8/);
  await acct.setPassword('a-longer-password');
  assert.ok(cloud.calls.some((c) => c.path === '/auth/v1/user'));
  await acct.signOut();
  await assert.rejects(acct.signUp('new@x.io', 'short'), /at least 8/);
  await acct.signUp('new@x.io', 'long-enough-pw');
  assert.strictEqual(acct.status().pending.kind, 'signup');
  assert.strictEqual(acct.status().signedIn, false);
  await acct.resetPassword('me@x.io');
  const redir5 = new URL(cloud.calls.filter((c) => c.path.startsWith('/auth/v1/recover')).pop().path, 'https://x').searchParams.get('redirect_to');
  const rr = await get(redir5 + '?code=good');
  assert.match(rr.text, /new password/);
  assert.strictEqual(acct.status().mustSetPassword, true);
  await acct.setPassword('brand-new-password');
  assert.strictEqual(acct.status().mustSetPassword, false);
  await acct.signOut();

  // a sign-in link survives a restart: new instance listens on the same port
  await acct.startEmail('me@x.io');
  const redir6 = new URL(cloud.calls.filter((c) => c.path.startsWith('/auth/v1/otp')).pop().path, 'https://x').searchParams.get('redirect_to');
  const savedPending = fs.readFileSync(path.join(dir, 'pending.bin'), 'utf8');
  acct.cancel(); // frees the port (and removes the file)...
  fs.writeFileSync(path.join(dir, 'pending.bin'), savedPending); // ...as if the app had crashed
  const acct2 = mk();
  await acct2.resumed;
  assert.strictEqual(acct2.status().pending.email, 'me@x.io', 'pending sign-in resumed');
  const r6 = await get(redir6 + '?code=good');
  assert.match(r6.text, /signed in/);
  assert.strictEqual(acct2.status().signedIn, true);
  await acct2.signOut();

  // expired saved sign-in is dropped
  fs.writeFileSync(path.join(dir, 'pending.bin'), 'p1:' + Buffer.from(JSON.stringify({ kind: 'email', email: 'a@b.io', verifier: 'v', port: 1, expires: t - 1 })).toString('base64'));
  const acct3 = mk();
  await acct3.resumed;
  assert.strictEqual(acct3.status().pending, null);
  assert.ok(!fs.existsSync(path.join(dir, 'pending.bin')));

  // code instead of the link
  await acct3.startEmail('me@x.io');
  await assert.rejects(acct3.verifyCode('12'), /Enter the code/);
  await assert.rejects(acct3.verifyCode('000000'), /wrong or expired/);
  await acct3.verifyCode('123 456');
  assert.strictEqual(acct3.status().signedIn, true);
  assert.strictEqual(acct3.status().pending, null);

  // reset via code -> must set password, survives a restart until done
  await acct3.signOut();
  await acct3.resetPassword('me@x.io');
  await acct3.verifyCode('123456');
  assert.strictEqual(acct3.status().mustSetPassword, true);
  assert.strictEqual(mk().status().mustSetPassword, true, 'still asked after restart');
  await acct3.setPassword('new-password-ok');
  assert.strictEqual(mk().status().mustSetPassword, false);

  // delete account
  const del = await acct3.deleteAccount();
  assert.strictEqual(del.userId, 'u1');
  assert.strictEqual(acct3.status().signedIn, false);
  assert.ok(!fs.existsSync(path.join(dir, 'session.bin')));

  // an unreadable session says so and is removed
  fs.writeFileSync(path.join(dir, 'session.bin'), 'v1:garbage');
  const acct4 = mk();
  assert.strictEqual(acct4.status().signedIn, false);
  assert.match(acct4.status().error, /couldn’t be read/);
  assert.ok(!fs.existsSync(path.join(dir, 'session.bin')));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('account tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
