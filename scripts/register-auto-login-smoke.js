process.env.MARKET_TEST_MODE = 'true';
process.env.BOOTSTRAP_ADMIN_EMAIL = 'register-auto-admin@example.com';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'AdminRegister123!';
process.env.DATA_FILE = require('path').join(require('os').tmpdir(), `hb9-register-auto-${process.pid}.json`);

const assert = require('assert');
const fs = require('fs');
const { server, readDB } = require('../server');

async function request(base, route, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || payload.message || 'Request failed'), { status: response.status, payload });
  return payload;
}

(async () => {
  readDB();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const sponsor = await request(base, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Sponsor User', email: 'sponsor-auto@example.com', password: 'password123' }
  });
  assert(sponsor.token, 'normal registration returns auth token');
  assert.strictEqual(sponsor.user.email, 'sponsor-auto@example.com');
  assert(!('passwordHash' in sponsor.user), 'registration response must not expose password hash');
  assert(!('salt' in sponsor.user), 'registration response must not expose password salt');

  const sponsorDashboard = await request(base, '/api/dashboard', { token: sponsor.token });
  assert.strictEqual(sponsorDashboard.user.email, 'sponsor-auto@example.com', 'registration token opens dashboard');

  const referred = await request(base, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Referred User', email: 'referred-auto@example.com', password: 'password123', sponsorEmail: 'SPONSOR-AUTO@example.com' }
  });
  assert(referred.token, 'referral registration returns auth token');
  const referredDashboard = await request(base, '/api/dashboard', { token: referred.token });
  assert.strictEqual(referredDashboard.user.email, 'referred-auto@example.com', 'referral registration token opens dashboard');

  const db = readDB();
  const sponsorUser = db.users.find(user => user.email === 'sponsor-auto@example.com');
  const referredUser = db.users.find(user => user.email === 'referred-auto@example.com');
  assert.strictEqual(referredUser.sponsorId, sponsorUser.id, 'referral sponsor remains attached after auto-login registration');
  assert.strictEqual(referredUser.walletAddress, null, 'registration still does not require wallet address');

  console.log('register-auto-login-smoke ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  server.close();
  try { fs.unlinkSync(process.env.DATA_FILE); } catch (_) {}
});
